import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';

export interface ServicesStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  n8nFileSystem: efs.IFileSystem;
  n8nAccessPoint: efs.IAccessPoint;
  /**
   * Public hostname n8n will be served from (Cloudflare Tunnel target).
   * Used for WEBHOOK_URL so callback URLs in OAuth/WhatsApp/etc resolve correctly.
   */
  n8nPublicHost?: string;
  /**
   * Container image tags, sourced from image-tags.json at repo root.
   * Bump the file and redeploy to roll a service.
   */
  imageTags: {
    laguna: string;
    n8n: string;
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
      n8nFileSystem,
      n8nAccessPoint,
      n8nPublicHost,
      imageTags,
    } = props;

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
    // Pass via: cdk deploy -c cfTunnelLaguna=xxx -c cfTunnelN8n=xxx
    // Or set in cdk.json context
    const cfTunnelLaguna = this.node.tryGetContext('cfTunnelLaguna') || '';
    const cfTunnelN8n = this.node.tryGetContext('cfTunnelN8n') || '';

    // n8n encryption key — used to encrypt stored credentials at rest.
    // Auto-generated, 48 chars, excludes punctuation that breaks env parsing.
    // NEVER rotate after first deploy: existing creds become unreadable.
    const n8nEncryptionKey = new secretsmanager.Secret(this, 'N8nEncryptionKey', {
      secretName: `${projectName}/n8n/encryption-key`,
      description: 'n8n N8N_ENCRYPTION_KEY — encrypts credential payloads',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Laguna Escondida ---
    const laguna = new EcsService(this, 'Laguna', {
      vpc,
      cluster,
      namespace,
      serviceName: 'laguna',
      containerImage: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/laguna-escondida:${imageTags.laguna}`,
      containerPort: 8080,
      cpu: 256,
      memory: 512,
      desiredCount: 1,
      cloudflareTunnelToken: cfTunnelLaguna,
      environment: {
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        DB_NAME: 'laguna',
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // --- n8n (workflow automation) ---
    // Runs as uid 1000 (n8n container's `node` user). State persists on EFS
    // at /home/node/.n8n via Access Point (chrooted + uid/gid enforced).
    // Encryption key MUST stay stable — losing it means re-entering every credential.
    const n8nWebhookUrl = n8nPublicHost
      ? `https://${n8nPublicHost}/`
      : '';

    const n8n = new EcsService(this, 'N8n', {
      vpc,
      cluster,
      namespace,
      serviceName: 'n8n',
      containerImage: `n8nio/n8n:${imageTags.n8n}`,
      containerPort: 5678,
      cpu: 512,
      memory: 1024,
      desiredCount: 1,
      cloudflareTunnelToken: cfTunnelN8n,
      healthCheckPath: '/healthz',
      environment: {
        DB_TYPE: 'postgresdb',
        DB_POSTGRESDB_HOST: dbAddress,
        DB_POSTGRESDB_PORT: dbPort,
        DB_POSTGRESDB_DATABASE: 'n8n',
        DB_POSTGRESDB_USER: 'dbadmin',
        N8N_PROXY_HOPS: '1',
        N8N_HOST: n8nPublicHost ?? '',
        N8N_PROTOCOL: 'https',
        N8N_PORT: '5678',
        WEBHOOK_URL: n8nWebhookUrl,
        GENERIC_TIMEZONE: 'America/Mexico_City',
        EXECUTIONS_MODE: 'regular',
      },
      secrets: {
        DB_POSTGRESDB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        N8N_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(n8nEncryptionKey),
      },
      efsVolumes: [
        {
          fileSystem: n8nFileSystem,
          accessPoint: n8nAccessPoint,
          containerPath: '/home/node/.n8n',
          volumeName: 'n8n-data',
        },
      ],
    });

    // Grant all services DB access — ingress added on imported SG handle
    // so the rule resource lives in this stack.
    [laguna, n8n].forEach((svc) => {
      dbSgLocal.addIngressRule(
        svc.securityGroup,
        ec2.Port.tcp(5432),
        `${svc.node.id} -> postgres`,
      );
    });
  }
}
