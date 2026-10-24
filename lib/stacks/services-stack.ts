import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';

// Laguna's organization (backend migration 33). Not secret.
const LAGUNA_ORGANIZATION_ID = 'bb0cad3e-be13-4bad-9a37-bba9525bfece';
// uuid5(NAMESPACE_URL, "laguna-escondida/node/<LAGUNA_ORGANIZATION_ID>/cloud"): the
// cloud id an edge box derives by default (backend config.CloudNodeIDFor).
const LAGUNA_CLOUD_NODE_ID = '45598059-e12e-530c-86b6-758477c4423d';

export interface ServicesStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  /**
   * Stack owning all ECR repos. ServicesStack reads `ecr.laguna`, `ecr.aiAgents`,
   * etc. directly — add a repo to EcrStack and it's available here, no prop wiring.
   * Lifecycle decoupled: destroy services, images survive.
   */
  ecr: EcrStack;
  assetsBucket: s3.IBucket;
  /**
   * Container image tags, sourced from image-tags.json at repo root.
   * Bump the file and redeploy to roll a service.
   */
  imageTags: {
    laguna: string;
    cloudflared: string;
    alloy: string;
  };
}

export class ServicesStack extends cdk.Stack {
  /** laguna's task SG; consumers re-import it to add their own ingress. */
  public readonly lagunaSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const {
      projectName,
      vpc,
      cluster,
      namespace,
      database,
      dbSecurityGroup,
      ecr,
      assetsBucket,
      imageTags,
    } = props;

    // Release-driven deploys: image at imageTags.laguna must exist in ECR
    // before `cdk deploy` runs. Override to 0 if you need to scale down:
    //   cdk deploy -c lagunaDesiredCount=0
    const lagunaDesiredCount = Number(
      this.node.tryGetContext('lagunaDesiredCount') ?? 1,
    );

    // Re-import DB SG by ID so ingress rules added below land in this
    // (services) stack, not the data stack. Avoids data <-> services cycle.
    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );

    const dbAddress = database.dbInstanceEndpointAddress;
    const dbPort = database.dbInstanceEndpointPort;

    // Infra/platform secrets the laguna RUNTIME reads — one JSON secret, billed per
    // secret not per key, so add keys instead of new secrets. IAM grants access to
    // the whole secret, so ONLY put values the task itself may read here (tunnel
    // token, future sidecar/agent creds). Deploy-time/provisioning credentials
    // (e.g. a Cloudflare *API* token that can edit DNS) must NOT live here — keep
    // those in a separate secret no task ever reads. Create it once:
    //   aws secretsmanager create-secret --name <projectName>/laguna/infra \
    //     --region us-east-1 --secret-string '{"CF_TUNNEL_TOKEN":"<token>"}'
    // The sidecar reads CF_TUNNEL_TOKEN as TUNNEL_TOKEN. Skip the tunnel for a
    // VPC-only boot test with: cdk deploy bryan-dev-services -c lagunaTunnel=off
    const lagunaInfraSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LagunaInfraSecret',
      `${projectName}/laguna/infra`,
    );
    const tunnelEnabled = this.node.tryGetContext('lagunaTunnel') !== 'off';
    const cfTunnelTokenSecret = tunnelEnabled
      ? ecs.Secret.fromSecretsManager(lagunaInfraSecret, 'CF_TUNNEL_TOKEN')
      : undefined;

    // --- Observability: Grafana Alloy sidecar (Phase 1) ---
    // The Alloy sidecar ships the app's logs/metrics/traces to Grafana Cloud. Its
    // config is a non-secret HCL file kept in the repo; the Grafana Cloud creds
    // (OTLP gateway endpoint, instance ID, access-policy token) are three keys in
    // the SAME laguna/infra secret as the tunnel token — add them there before
    // deploy or the task fails to start. Only the token is truly sensitive, but
    // all three are injected as secrets to keep it one place. The app never holds
    // these — only Alloy does. Skip the sidecar for a boot test with:
    //   cdk deploy bryan-dev-services -c lagunaAlloy=off
    const alloyEnabled = this.node.tryGetContext('lagunaAlloy') !== 'off';
    const alloyConfig = fs.readFileSync(
      path.join(__dirname, '..', '..', 'observability', 'alloy', 'ecs-cloud.alloy'),
      'utf8',
    );
    const alloySecrets = alloyEnabled
      ? {
          GRAFANA_CLOUD_OTLP_ENDPOINT: ecs.Secret.fromSecretsManager(lagunaInfraSecret, 'GRAFANA_CLOUD_OTLP_ENDPOINT'),
          GRAFANA_CLOUD_OTLP_USER: ecs.Secret.fromSecretsManager(lagunaInfraSecret, 'GRAFANA_CLOUD_OTLP_USER'),
          GRAFANA_CLOUD_OTLP_TOKEN: ecs.Secret.fromSecretsManager(lagunaInfraSecret, 'GRAFANA_CLOUD_OTLP_TOKEN'),
        }
      : undefined;

    // deployment.environment for telemetry resource attrs. Read from cdk.json
    // context (`env`), the same value bin/app.ts validates; defaults to 'dev' so
    // the offline test harness (which sets no context) still synths.
    const deployEnv = String(this.node.tryGetContext('env') ?? 'dev');

    // App-level config (invoice provider, JWT, admin key, object-storage creds,
    // org id) lives in one JSON secret created out-of-band — never in the template:
    //   aws secretsmanager create-secret --name <projectName>/laguna/app \
    //     --secret-string '{"JWT_SECRET":"...","ADMIN_API_KEY":"...", ...}'
    // Imported by name (not ARN) so rotating the values never produces a stack diff.
    // Every key referenced below MUST exist in that secret or the task fails to start.
    const lagunaAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LagunaAppSecret',
      `${projectName}/laguna/app`,
    );

    // CloudFront private key for signing asset URLs — stored as raw PEM (not JSON).
    const lagunaCfSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LagunaCfSecret',
      `${projectName}/laguna/cloudfront`,
    );

    // --- Laguna Escondida ---
    const laguna = new EcsService(this, 'Laguna', {
      vpc,
      cluster,
      namespace,
      serviceName: 'laguna',
      containerImage: ecs.ContainerImage.fromEcrRepository(ecr.laguna, imageTags.laguna),
      containerPort: 8080,
      cpu: 256,
      memory: 512,
      desiredCount: lagunaDesiredCount,
      cloudflareTunnelTokenSecret: cfTunnelTokenSecret,
      // Pinned sidecar tag from image-tags.json — avoids `latest` re-pulling a
      // new cloudflared on every task placement (spot reclaim, scale, restart).
      cloudflaredImage: ecs.ContainerImage.fromRegistry(
        `cloudflare/cloudflared:${imageTags.cloudflared}`,
      ),
      // Telemetry sidecar — pinned grafana/alloy tag from image-tags.json (pulled
      // from Docker Hub, same as cloudflared). Config + creds wired above.
      alloyImage: alloyEnabled
        ? ecs.ContainerImage.fromRegistry(`grafana/alloy:${imageTags.alloy}`)
        : undefined,
      alloyConfig: alloyEnabled ? alloyConfig : undefined,
      alloySecrets,
      // App serves /api/health (not /health); the construct health check hits this.
      healthCheckPath: '/api/health',
      environment: {
        // The Go server panics if PORT is unset; keep it equal to containerPort.
        PORT: '8080',
        // cloud = sync-aggregate mode (vs. 'edge' restaurant node). See cmd/main.go.
        APP_MODE: 'cloud',
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        // One database per project on the shared RDS instance; keeps the DO name.
        DB_NAME: 'laguna_escondida',
        // RDS Postgres 16 defaults rds.force_ssl=1, so plaintext is refused.
        DB_SSLMODE: 'require',
        // CloudFront key pair ID for signed URL generation (not sensitive).
        CDN_KEY_PAIR_ID: 'K12A0TYQP3OGH7',
        // Observability (Phase 1) — the app exports to the Alloy sidecar over the
        // shared task loopback; Alloy forwards to Grafana Cloud. These are inert
        // until the backend image adds the OTel SDK (implemented separately); the
        // current image simply ignores unknown env. See
        // docs/observability-backend-changes.md.
        OBSERVABILITY_ENABLED: alloyEnabled ? 'true' : 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_SERVICE_NAME: 'laguna',
        // Ties every span/log/metric to the deployed release (from image-tags.json).
        SERVICE_VERSION: imageTags.laguna,
        ENVIRONMENT: deployEnv,
        // Prometheus /metrics listener the Alloy sidecar scrapes (separate port so
        // it's never exposed via the Cloudflare Tunnel).
        METRICS_PORT: '9090',
        // Edge telemetry relay: the Windows POS boxes POST to the backend's
        // /api/telemetry/v1/* routes, which authenticate the node, stamp tenant
        // identity, and forward the export to Alloy's DEDICATED relay receiver
        // over task loopback (see observability/alloy/ecs-cloud.alloy). Gated on
        // the sidecar: with `-c lagunaAlloy=off` the backend must NOT register
        // the ingest routes, or every edge POST forwards into a void, 502s, and
        // the boxes spin on retry. Unsetting this is also the rollback switch.
        // TELEMETRY_TENANT_ID (the Grafana tenant relayed telemetry lands in) is required
        // with it since the cloud went multi-tenant; it used to default to the org.
        ...(alloyEnabled
          ? {
              TELEMETRY_FORWARD_URL: 'http://127.0.0.1:4319',
              TELEMETRY_TENANT_ID: LAGUNA_ORGANIZATION_ID,
            }
          : {}),
        // Multi-tenant cloud (backend v1.2.0+): no ORGANIZATION_ID (the org comes from
        // each caller; setting it is a boot error), and NODE_ID must be set. It keeps the
        // id Laguna's box derives for the cloud, or the box's sync_state goes stale.
        NODE_ID: LAGUNA_CLOUD_NODE_ID,
      },
      secrets: {
        // DB creds are the app-scoped role `laguna_app` (created by
        // scripts/db/create-laguna-role.sql), NOT the shared master `dbadmin`.
        // A leak of these can only touch laguna_escondida — no other database on
        // the shared instance. Values live in the app secret; host/port/name are
        // set above as plain env because CDK knows them, not the secret.
        DB_USER: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'DB_USER'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'DB_PASSWORD'),
        // Required by config.NewConfig() — any empty value is a fatal boot error.
        JWT_SECRET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'JWT_SECRET'),
        ADMIN_API_KEY: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ADMIN_API_KEY'),
        ELECTRONIC_INVOICE_URL: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_URL'),
        ELECTRONIC_INVOICE_USER: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_USER'),
        ELECTRONIC_INVOICE_PASSWORD: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_PASSWORD'),
        STORAGE_BUCKET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'STORAGE_BUCKET'),
        STORAGE_REGION: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'STORAGE_REGION'),
        CDN_URL: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'CDN_URL'),
        NODE_SYNC_KEY: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'NODE_SYNC_KEY'),
        // Raw PEM — entire secret value, no JSON field.
        CDN_PRIVATE_KEY: ecs.Secret.fromSecretsManager(lagunaCfSecret),
      },
    });

    // --- Customer MCP server (sidecar) ---
    // The WhatsApp agent takes takeaway/delivery orders through the backend's MCP
    // server (cmd/mcp-server) with MCP_TOOLSET=customer: only the 7 customer
    // tools, signed in as a user holding ONLY the `agent` role, so neither the
    // toolset nor a leaked credential reaches staff endpoints. Same image and
    // release as the app (the binary ships at /app/mcp-server), talking to it over
    // task loopback. Listens on :8090 on the task ENI — the task has a public IP,
    // so the security group is the boundary: MarketingStack opens 8090 to the
    // agent's SG only, and every /mcp call also needs the bearer token.
    // Non-essential: an MCP crash costs the agent its orders tools (it degrades
    // to answering without them), never the POS backend.
    // Keys to add to <projectName>/laguna/app before deploying:
    //   MCP_CUSTOMER_USERNAME / MCP_CUSTOMER_PASSWORD — the agent-role user
    //   MCP_CUSTOMER_AUTH_TOKEN — shared bearer (same value as the agent's
    //     ORDERS_MCP_TOKEN_LAGUNA_ESCONDIDA in <projectName>/whatsapp-agent/app)
    // Needs a laguna image that ships the binary. Skip with -c lagunaMcp=off.
    const mcpEnabled = this.node.tryGetContext('lagunaMcp') !== 'off';
    if (mcpEnabled) {
      laguna.taskDefinition.addContainer('mcp-customer', {
        image: ecs.ContainerImage.fromEcrRepository(ecr.laguna, imageTags.laguna),
        command: ['./mcp-server'],
        essential: false,
        memoryLimitMiB: 128,
        portMappings: [{ containerPort: 8090 }],
        environment: {
          MCP_TOOLSET: 'customer',
          MCP_ADDR: ':8090',
          LAGUNA_API_URL: 'http://127.0.0.1:8080',
        },
        secrets: {
          LAGUNA_USERNAME: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'MCP_CUSTOMER_USERNAME'),
          LAGUNA_PASSWORD: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'MCP_CUSTOMER_PASSWORD'),
          MCP_AUTH_TOKEN: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'MCP_CUSTOMER_AUTH_TOKEN'),
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup: laguna.logGroup,
          streamPrefix: 'mcp-customer',
        }),
        // Alpine runtime: busybox wget, no curl. /health is unauthenticated.
        healthCheck: {
          command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:8090/health || exit 1'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(30),
        },
      });
    }
    this.lagunaSecurityGroup = laguna.securityGroup;

    // Grant laguna read/write access to the assets bucket via task role —
    // no explicit AWS credentials needed in the app; the SDK picks up the role.
    assetsBucket.grantReadWrite(laguna.taskDefinition.taskRole);

    // Allow the task to read the CloudFront private key at startup.
    lagunaCfSecret.grantRead(laguna.taskDefinition.taskRole);

    // Grant laguna DB access — ingress added on imported SG handle
    // so the rule resource lives in this stack.
    dbSgLocal.addIngressRule(
      laguna.securityGroup,
      ec2.Port.tcp(5432),
      // NB: SG rule descriptions reject '>' — keep it to the allowed charset.
      `${laguna.node.id} to postgres`,
    );
  }
}
