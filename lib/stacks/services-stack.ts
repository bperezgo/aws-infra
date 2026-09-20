import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';

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
    microbiomeApi: string;
    microbiomeWorker: string;
    microbiomeUi: string;
  };
}

export class ServicesStack extends cdk.Stack {
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
        ELECTRONIC_INVOICE_PREFIX: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_PREFIX'),
        SUPPORT_DOCUMENT_PREFIX: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SUPPORT_DOCUMENT_PREFIX'),
        STORAGE_BUCKET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'STORAGE_BUCKET'),
        STORAGE_REGION: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'STORAGE_REGION'),
        CDN_URL: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'CDN_URL'),
        ORGANIZATION_ID: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ORGANIZATION_ID'),
        NODE_SYNC_KEY: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'NODE_SYNC_KEY'),
        // Raw PEM — entire secret value, no JSON field.
        CDN_PRIVATE_KEY: ecs.Secret.fromSecretsManager(lagunaCfSecret),
      },
    });

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

    // --- microbiome-lab (api + worker + ui) ---
    // A shared cloudflared image for the public services. Pinned tag from
    // image-tags.json so a spot reclaim never re-pulls a new cloudflared.
    const cloudflaredImage = ecs.ContainerImage.fromRegistry(
      `cloudflare/cloudflared:${imageTags.cloudflared}`,
    );

    // Two JSON secrets, imported by name so rotating values never diffs the stack.
    // app:   DB app-role creds (microbiome_app) + INGEST_API_TOKEN.
    // infra: API_CF_TUNNEL_TOKEN + UI_CF_TUNNEL_TOKEN.
    // Both are created out-of-band (laguna convention); every key referenced below
    // MUST exist in them or the task fails to start:
    //   aws secretsmanager create-secret --name <projectName>/microbiome-lab/app ...
    //   aws secretsmanager create-secret --name <projectName>/microbiome-lab/infra ...
    const mlAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'MlAppSecret',
      `${projectName}/microbiome-lab/app`,
    );
    const mlInfraSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'MlInfraSecret',
      `${projectName}/microbiome-lab/infra`,
    );

    // Boot-test escape hatch, mirroring lagunaTunnel: bring the tasks up VPC-only
    // (no cloudflared sidecar) before the Cloudflare side is wired, with:
    //   cdk deploy bryan-dev-services -c microbiomeTunnel=off
    const microbiomeTunnelEnabled =
      this.node.tryGetContext('microbiomeTunnel') !== 'off';
    const apiTunnelSecret = microbiomeTunnelEnabled
      ? ecs.Secret.fromSecretsManager(mlInfraSecret, 'API_CF_TUNNEL_TOKEN')
      : undefined;
    const uiTunnelSecret = microbiomeTunnelEnabled
      ? ecs.Secret.fromSecretsManager(mlInfraSecret, 'UI_CF_TUNNEL_TOKEN')
      : undefined;

    // SQS: api SendMessage -> worker ReceiveMessage. The queue carries only
    // {sample_id}; the DB is the source of truth. Not in the Guardrails stateful
    // set (S3/RDS/ECR/EFS) — transient infra, so the default RemovalPolicy is fine.
    // maxReceiveCount 5 / visibility 30s mirror the worker's defaults and the
    // LocalStack init the app already uses.
    const samplesDlq = new sqs.Queue(this, 'SamplesDlq', {
      queueName: 'microbiome-lab-samples-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });
    const samplesQueue = new sqs.Queue(this, 'SamplesQueue', {
      queueName: 'microbiome-lab-samples',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: { queue: samplesDlq, maxReceiveCount: 5 },
    });

    // Shared env for api + worker (DB + SQS + region). We deliberately set NEITHER
    // AWS_ACCESS_KEY_ID/SECRET (so the SDK uses the task role) NOR AWS_ENDPOINT_URL
    // (that's LocalStack-only; unset => real SQS).
    const microbiomeDataEnv: Record<string, string> = {
      DB_HOST: dbAddress,
      DB_PORT: dbPort,
      DB_NAME: 'microbiome_lab',
      // RDS enforces rds.force_ssl=1, so plaintext is refused.
      DB_SSLMODE: 'require',
      SQS_QUEUE_URL: samplesQueue.queueUrl,
      AWS_REGION: this.region,
      PRACTITIONER_EMAIL: 'practitioner@vitract.example',
      LOG_LEVEL: 'info',
      // No alloy sidecar for the demo (plan default off); app ignores unknown env.
      OBSERVABILITY_ENABLED: 'false',
    };

    // API — public (cloudflared). Persists `pending` + SendMessage {sample_id}.
    const microbiomeApi = new EcsService(this, 'MicrobiomeApi', {
      vpc,
      cluster,
      namespace,
      serviceName: 'microbiome-api',
      containerImage: ecs.ContainerImage.fromEcrRepository(
        ecr.microbiomeApi,
        imageTags.microbiomeApi,
      ),
      containerPort: 8080,
      cpu: 256,
      memory: 512, // -> 1024 automatically (tunnel sidecar present)
      desiredCount: Number(
        this.node.tryGetContext('microbiomeApiDesiredCount') ?? 1,
      ),
      healthCheckPath: '/api/health',
      cloudflareTunnelTokenSecret: apiTunnelSecret,
      cloudflaredImage,
      environment: {
        ...microbiomeDataEnv,
        API_PORT: '8080',
        INGEST_RATE_LIMIT_PER_SEC: '20',
        INGEST_RATE_LIMIT_BURST: '40',
      },
      secrets: {
        // App-scoped role microbiome_app (create-microbiome-role.sql), NOT the RDS
        // master — a leak is contained to the microbiome_lab database.
        DB_USER: ecs.Secret.fromSecretsManager(mlAppSecret, 'DB_USER'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(mlAppSecret, 'DB_PASSWORD'),
        // Required at api startup; the worker serves no ingest route so never gets it.
        INGEST_API_TOKEN: ecs.Secret.fromSecretsManager(mlAppSecret, 'INGEST_API_TOKEN'),
      },
    });
    // Least-privilege SQS — producer only.
    samplesQueue.grantSendMessages(microbiomeApi.taskDefinition.taskRole);
    dbSgLocal.addIngressRule(
      microbiomeApi.securityGroup,
      ec2.Port.tcp(5432),
      'microbiome-api to postgres',
    );

    // WORKER — private (SQS-only, no tunnel). Health server on 8081.
    const microbiomeWorker = new EcsService(this, 'MicrobiomeWorker', {
      vpc,
      cluster,
      namespace,
      serviceName: 'microbiome-worker',
      containerImage: ecs.ContainerImage.fromEcrRepository(
        ecr.microbiomeWorker,
        imageTags.microbiomeWorker,
      ),
      containerPort: 8081,
      cpu: 256,
      memory: 512, // stays 512 — no sidecar
      desiredCount: Number(
        this.node.tryGetContext('microbiomeWorkerDesiredCount') ?? 1,
      ),
      healthCheckPath: '/api/health',
      // No tunnel secret -> the construct adds no cloudflared sidecar. cloudflaredImage
      // is a required prop but goes unreferenced without a token.
      cloudflaredImage,
      environment: {
        ...microbiomeDataEnv,
        WORKER_HEALTH_PORT: '8081',
        WORKER_MAX_MESSAGES: '10',
        WORKER_WAIT_TIME_SECONDS: '10',
        WORKER_VISIBILITY_TIMEOUT_SECONDS: '30',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(mlAppSecret, 'DB_USER'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(mlAppSecret, 'DB_PASSWORD'),
        // No INGEST_API_TOKEN — the worker serves no ingest route.
      },
    });
    // Least-privilege SQS — consumer only.
    samplesQueue.grantConsumeMessages(microbiomeWorker.taskDefinition.taskRole);
    dbSgLocal.addIngressRule(
      microbiomeWorker.securityGroup,
      ec2.Port.tcp(5432),
      'microbiome-worker to postgres',
    );

    // UI — public (cloudflared). No DB, no SQS. Fetches the api server-side over
    // Cloud Map (never leaves the VPC); the public hostname is only for the browser.
    new EcsService(this, 'MicrobiomeUi', {
      vpc,
      cluster,
      namespace,
      serviceName: 'microbiome-ui',
      containerImage: ecs.ContainerImage.fromEcrRepository(
        ecr.microbiomeUi,
        imageTags.microbiomeUi,
      ),
      containerPort: 3000,
      cpu: 256,
      memory: 512, // -> 1024 (tunnel present)
      desiredCount: Number(
        this.node.tryGetContext('microbiomeUiDesiredCount') ?? 1,
      ),
      healthCheckPath: '/',
      cloudflareTunnelTokenSecret: uiTunnelSecret,
      cloudflaredImage,
      environment: {
        // Server-side fetch target; internal Cloud Map DNS for the api service.
        API_BASE_URL: `http://microbiome-api.${projectName}.local:8080`,
      },
    });
  }
}
