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
  }
}
