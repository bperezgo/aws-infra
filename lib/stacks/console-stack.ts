import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';
import { MARKETING_DB } from './marketing-stack';

export interface ConsoleStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  ecr: EcrStack;
  imageTags: {
    consoleApi: string;
    cloudflared: string;
  };
}

/** console-api's login role; holds marketing_console, the app's grant holder. */
export const MARKETING_CONSOLE_SVC_ROLE = 'marketing_console_svc';

/**
 * marketing-app's operations console: console-api, a Go service that serves the
 * built console-web from the same origin (its session cookie is SameSite=Strict),
 * reached through its own Cloudflare Tunnel.
 *
 * A stack of its own, apart from MarketingStack, so a console deploy never rolls
 * the WhatsApp agent. It reads the agent's database through the
 * marketing_console role; schema changes still go through the migrate task in
 * DbAdminStack first — the service refuses to boot on an older schema.
 *
 * `/internal/provision` must not be reachable from the internet: block it at the
 * Cloudflare edge (a WAF rule on the hostname) and provision over an SSM
 * port-forward instead. The task SG takes no inbound traffic.
 */
export class ConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props);

    const { projectName, vpc, cluster, namespace, database, dbSecurityGroup, ecr, imageTags } =
      props;

    const ctx = (key: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined ? undefined : String(v);
    };
    const desiredCount = Number(ctx('consoleDesiredCount') ?? 1);
    const tunnelEnabled = ctx('consoleTunnel') !== 'off';
    const port = 8090;

    // What the running app reads. Create once (both keys must exist or the task
    // fails to start):
    //   aws secretsmanager create-secret --name <projectName>/console-api/app \
    //     --secret-string '{"DB_PASSWORD":"…","CONSOLE_PROVISION_TOKEN":"…"}'
    // DB_PASSWORD is marketing_console_svc's — the db-admin task sets the role from it.
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ConsoleApiAppSecret',
      `${projectName}/console-api/app`,
    );
    // What the tunnel sidecar reads: CF_TUNNEL_TOKEN. Its own tunnel and secret,
    // so neither the agent's nor laguna's task can read it.
    const infraSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ConsoleApiInfraSecret',
      `${projectName}/console-api/infra`,
    );

    const databaseUrl =
      `postgres://${MARKETING_CONSOLE_SVC_ROLE}@${database.dbInstanceEndpointAddress}:` +
      `${database.dbInstanceEndpointPort}/${MARKETING_DB}?sslmode=require`;

    const console = new EcsService(this, 'ConsoleApi', {
      vpc,
      cluster,
      namespace,
      serviceName: 'console-api',
      containerImage: ecs.ContainerImage.fromEcrRepository(ecr.consoleApi, imageTags.consoleApi),
      containerPort: port,
      cpu: 256,
      memory: 512,
      desiredCount,
      cloudflareTunnelTokenSecret: tunnelEnabled
        ? ecs.Secret.fromSecretsManager(infraSecret, 'CF_TUNNEL_TOKEN')
        : undefined,
      cloudflaredImage: ecs.ContainerImage.fromRegistry(
        `cloudflare/cloudflared:${imageTags.cloudflared}`,
      ),
      // Distroless image: the binary probes its own /healthz.
      healthCheckCommand: ['/app/console-api', 'healthcheck'],
      // Reached only through the tunnel; nothing resolves it inside the VPC.
      cloudMap: false,
      // PRODUCTS_DIR and CONSOLE_WEB_DIR come from the image.
      environment: {
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: 'info',
        // Behind the tunnel every connection comes from cloudflared on loopback,
        // so the per-source sign-in throttle would lump all clients together.
        // Safe to trust: the SG takes no inbound, so only cloudflared reaches it.
        ...(tunnelEnabled ? { CONSOLE_CLIENT_IP_HEADER: 'CF-Connecting-IP' } : {}),
      },
      secrets: {
        PGPASSWORD: ecs.Secret.fromSecretsManager(appSecret, 'DB_PASSWORD'),
        CONSOLE_PROVISION_TOKEN: ecs.Secret.fromSecretsManager(
          appSecret,
          'CONSOLE_PROVISION_TOKEN',
        ),
      },
    });

    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );
    dbSgLocal.addIngressRule(console.securityGroup, ec2.Port.tcp(5432), 'console-api to postgres');
  }
}
