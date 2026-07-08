import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
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
  /**
   * Container image tags, sourced from image-tags.json at repo root.
   * Bump the file and redeploy to roll a service.
   */
  imageTags: {
    laguna: string;
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

    // Tunnel tokens from context or SSM
    // Pass via: cdk deploy -c cfTunnelLaguna=xxx
    // Or set in cdk.json context
    const cfTunnelLaguna = this.node.tryGetContext('cfTunnelLaguna') || '';

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
      cloudflareTunnelToken: cfTunnelLaguna,
      // App serves /api/health (not /health); the construct health check hits this.
      healthCheckPath: '/api/health',
      environment: {
        // The Go server panics if PORT is unset; keep it equal to containerPort.
        PORT: '8080',
        // cloud = sync-aggregate mode (vs. 'edge' restaurant node). See cmd/main.go.
        APP_MODE: 'cloud',
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        DB_NAME: 'laguna',
        // RDS Postgres 16 defaults rds.force_ssl=1, so plaintext is refused.
        DB_SSLMODE: 'require',
      },
      secrets: {
        // DB creds come from the RDS-generated master secret. The master user is
        // 'dbadmin' (see data-stack), NOT the app's 'postgres' default — so wire
        // the username too, don't rely on the default.
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        // Required by config.NewConfig() — any empty value is a fatal boot error.
        JWT_SECRET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'JWT_SECRET'),
        ADMIN_API_KEY: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ADMIN_API_KEY'),
        ELECTRONIC_INVOICE_URL: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_URL'),
        ELECTRONIC_INVOICE_USER: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_USER'),
        ELECTRONIC_INVOICE_PASSWORD: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ELECTRONIC_INVOICE_PASSWORD'),
        SPACES_REGION: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SPACES_REGION'),
        SPACES_ENDPOINT: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SPACES_ENDPOINT'),
        SPACES_KEY: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SPACES_KEY'),
        SPACES_SECRET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SPACES_SECRET'),
        SPACES_BUCKET: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'SPACES_BUCKET'),
        ORGANIZATION_ID: ecs.Secret.fromSecretsManager(lagunaAppSecret, 'ORGANIZATION_ID'),
      },
    });

    // Grant laguna DB access — ingress added on imported SG handle
    // so the rule resource lives in this stack.
    dbSgLocal.addIngressRule(
      laguna.securityGroup,
      ec2.Port.tcp(5432),
      `${laguna.node.id} -> postgres`,
    );
  }
}
