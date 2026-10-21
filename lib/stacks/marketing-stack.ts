import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';

export interface MarketingStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  /** laguna's task SG: the agent reaches its customer MCP sidecar on 8090. */
  lagunaSecurityGroup: ec2.ISecurityGroup;
  ecr: EcrStack;
  imageTags: {
    whatsappAgent: string;
    cloudflared: string;
    alloy: string;
  };
}

/** The database and login role the marketing-app services share. */
export const MARKETING_DB = 'marketing';
export const MARKETING_SVC_ROLE = 'marketing_svc';
export const MARKETING_OWNER_ROLE = 'marketing_owner';

const ALLOY_DIR = path.join(__dirname, '..', '..', 'observability', 'alloy');
const LANGFUSE_MARKER = '/*LANGFUSE_TRACES*/';

/**
 * The whatsapp-agent config, with the Langfuse trace branch appended when on.
 * Exported for tests; throws if the marker that wires the branch in is missing,
 * so an edit to the base file can't silently drop Langfuse.
 */
export function whatsappAgentAlloyConfig(langfuse: boolean): string {
  const base = fs.readFileSync(path.join(ALLOY_DIR, 'whatsapp-agent.alloy'), 'utf8');
  if (!base.includes(LANGFUSE_MARKER)) {
    throw new Error(`whatsapp-agent.alloy lost its ${LANGFUSE_MARKER} marker`);
  }
  if (!langfuse) return base.replace(LANGFUSE_MARKER, '');
  const branch = fs.readFileSync(
    path.join(ALLOY_DIR, 'whatsapp-agent-langfuse.alloy'),
    'utf8',
  );
  return (
    base.replace(LANGFUSE_MARKER, ', otelcol.processor.transform.langfuse.input') +
    '\n' +
    branch
  );
}

/**
 * marketing-app services. Today: the WhatsApp agent — a Go service that answers
 * customers through Claude, keeps conversations in Postgres, and receives Meta's
 * webhook through a Cloudflare Tunnel.
 *
 * A stack of its own so deploying it never touches laguna. Its schema is applied
 * by the one-off migrate task in DbAdminStack, BEFORE this stack rolls a new
 * image: the service refuses to boot on an unmigrated database.
 */
export class MarketingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarketingStackProps) {
    super(scope, id, props);

    const {
      projectName,
      vpc,
      cluster,
      namespace,
      database,
      dbSecurityGroup,
      lagunaSecurityGroup,
      ecr,
      imageTags,
    } = props;

    const ctx = (key: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined ? undefined : String(v);
    };
    const desiredCount = Number(ctx('whatsappAgentDesiredCount') ?? 1);
    const tunnelEnabled = ctx('whatsappAgentTunnel') !== 'off';
    const alloyEnabled = ctx('whatsappAgentAlloy') !== 'off';
    // On unless opted out: as an opt-in flag, one deploy that forgot it took
    // Langfuse out of production without anything failing.
    const langfuseEnabled = alloyEnabled && ctx('whatsappAgentLangfuse') !== 'off';
    // laguna's orders backend: the customer MCP sidecar in laguna's task
    // (ServicesStack, port 8090), by its Cloud Map name. The agent only uses it
    // for a product whose profile has `abilities: [orders]`. Off: the agent
    // logs a warning and takes no orders.
    const ordersEnabled = ctx('whatsappAgentOrders') !== 'off';
    const lagunaMcpPort = 8090;
    // serve refuses to start a product whose facts are stand-ins. develop is for a
    // Meta TEST number only — it lets placeholder contact details reach whoever
    // writes in.
    const readiness = ctx('whatsappAgentReadiness') ?? 'serve';
    if (readiness !== 'serve' && readiness !== 'develop') {
      throw new Error(`whatsappAgentReadiness must be serve|develop, got "${readiness}"`);
    }
    // Telemetry labels, not the cdk.json `env` (which only names the stacks): this
    // deployment serves real customers, and `marketing` groups the product's
    // services apart from laguna in Grafana.
    const telemetryEnv = 'production';
    const serviceNamespace = 'marketing';

    // What the running app reads. Create once (keys must all exist or the task
    // fails to start):
    //   aws secretsmanager create-secret --name <projectName>/whatsapp-agent/app \
    //     --secret-string '{"ANTHROPIC_API_KEY":"…","WHATSAPP_ACCESS_TOKEN":"…",
    //       "WHATSAPP_VERIFY_TOKEN":"…","WHATSAPP_APP_SECRET":"…","DB_PASSWORD":"…",
    //       "CLAUDE_MODEL":"…","CLAUDE_EFFORT":"…","STAFF_WHATSAPP_LAGUNA_ESCONDIDA":"…"}'
    // DB_PASSWORD is marketing_svc's — the db-admin task sets the role from it.
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'WhatsappAgentAppSecret',
      `${projectName}/whatsapp-agent/app`,
    );
    // What the sidecars read: CF_TUNNEL_TOKEN, GRAFANA_CLOUD_OTLP_{ENDPOINT,USER,
    // TOKEN}, and unless Langfuse is off LANGFUSE_{PUBLIC_KEY,SECRET_KEY,OTLP_ENDPOINT}.
    // Separate from laguna/infra so neither task can read the other's tunnel token.
    const infraSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'WhatsappAgentInfraSecret',
      `${projectName}/whatsapp-agent/infra`,
    );
    const infra = (key: string) => ecs.Secret.fromSecretsManager(infraSecret, key);

    const alloySecrets: Record<string, ecs.Secret> = {
      GRAFANA_CLOUD_OTLP_ENDPOINT: infra('GRAFANA_CLOUD_OTLP_ENDPOINT'),
      GRAFANA_CLOUD_OTLP_USER: infra('GRAFANA_CLOUD_OTLP_USER'),
      GRAFANA_CLOUD_OTLP_TOKEN: infra('GRAFANA_CLOUD_OTLP_TOKEN'),
      ...(langfuseEnabled
        ? {
            LANGFUSE_PUBLIC_KEY: infra('LANGFUSE_PUBLIC_KEY'),
            LANGFUSE_SECRET_KEY: infra('LANGFUSE_SECRET_KEY'),
            LANGFUSE_OTLP_ENDPOINT: infra('LANGFUSE_OTLP_ENDPOINT'),
          }
        : {}),
    };

    // No password in the URL: pgx (and lib/pq in the migrate task) fill it from
    // PGPASSWORD, which comes from the secret. Host/port are CDK-known, not secret.
    const databaseUrl =
      `postgres://${MARKETING_SVC_ROLE}@${database.dbInstanceEndpointAddress}:` +
      `${database.dbInstanceEndpointPort}/${MARKETING_DB}?sslmode=require`;

    const agent = new EcsService(this, 'WhatsappAgent', {
      vpc,
      cluster,
      namespace,
      serviceName: 'whatsapp-agent',
      containerImage: ecs.ContainerImage.fromEcrRepository(
        ecr.whatsappAgent,
        imageTags.whatsappAgent,
      ),
      containerPort: 8080,
      cpu: 256,
      memory: 512,
      desiredCount,
      cloudflareTunnelTokenSecret: tunnelEnabled ? infra('CF_TUNNEL_TOKEN') : undefined,
      cloudflaredImage: ecs.ContainerImage.fromRegistry(
        `cloudflare/cloudflared:${imageTags.cloudflared}`,
      ),
      alloyImage: alloyEnabled
        ? ecs.ContainerImage.fromRegistry(`grafana/alloy:${imageTags.alloy}`)
        : undefined,
      alloyConfig: alloyEnabled ? whatsappAgentAlloyConfig(langfuseEnabled) : undefined,
      alloySecrets: alloyEnabled ? alloySecrets : undefined,
      // Distroless image: no shell or wget, so the binary probes its own /healthz
      // (liveness — /readyz would fail on a Postgres blip and have ECS replace a
      // task that recovers by itself). Needs whatsapp-agent >= the release that
      // added the `healthcheck` subcommand.
      healthCheckCommand: ['/app/whatsapp-agent', 'healthcheck'],
      // Reached only through the tunnel; nothing resolves it inside the VPC.
      cloudMap: false,
      environment: {
        PORT: '8080',
        DATABASE_URL: databaseUrl,
        PRODUCT_READINESS: readiness,
        LOG_LEVEL: 'info',
        // Customer message text stays in Postgres under its retention window and
        // never reaches a telemetry backend.
        TELEMETRY_CONTENT: 'none',
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
        OTEL_SERVICE_NAME: 'whatsapp-agent',
        OTEL_RESOURCE_ATTRIBUTES:
          `deployment.environment.name=${telemetryEnv},service.namespace=${serviceNamespace},` +
          `service.version=${imageTags.whatsappAgent}`,
        // Unset means no telemetry at all in this app, so it follows the sidecar.
        ...(alloyEnabled ? { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' } : {}),
        ...(ordersEnabled
          ? {
              ORDERS_MCP_URL_LAGUNA_ESCONDIDA:
                `http://laguna.${namespace.namespaceName}:${lagunaMcpPort}/mcp`,
            }
          : {}),
      },
      secrets: {
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(appSecret, 'ANTHROPIC_API_KEY'),
        WHATSAPP_ACCESS_TOKEN: ecs.Secret.fromSecretsManager(appSecret, 'WHATSAPP_ACCESS_TOKEN'),
        WHATSAPP_VERIFY_TOKEN: ecs.Secret.fromSecretsManager(appSecret, 'WHATSAPP_VERIFY_TOKEN'),
        WHATSAPP_APP_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'WHATSAPP_APP_SECRET'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(appSecret, 'DB_PASSWORD'),
        // Optional to the app (it falls back to its own model and to the public
        // contact), but once named here the keys must exist in the secret.
        CLAUDE_MODEL: ecs.Secret.fromSecretsManager(appSecret, 'CLAUDE_MODEL'),
        CLAUDE_EFFORT: ecs.Secret.fromSecretsManager(appSecret, 'CLAUDE_EFFORT'),
        STAFF_WHATSAPP_LAGUNA_ESCONDIDA: ecs.Secret.fromSecretsManager(
          appSecret,
          'STAFF_WHATSAPP_LAGUNA_ESCONDIDA',
        ),
        // Same value as MCP_CUSTOMER_AUTH_TOKEN in <projectName>/laguna/app: each
        // task reads only its own secret.
        ...(ordersEnabled
          ? {
              ORDERS_MCP_TOKEN_LAGUNA_ESCONDIDA: ecs.Secret.fromSecretsManager(
                appSecret,
                'ORDERS_MCP_TOKEN_LAGUNA_ESCONDIDA',
              ),
            }
          : {}),
      },
    });

    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );
    dbSgLocal.addIngressRule(
      agent.securityGroup,
      ec2.Port.tcp(5432),
      // NB: SG rule descriptions reject '>' — keep it to the allowed charset.
      'whatsapp-agent to postgres',
    );

    if (ordersEnabled) {
      // Re-imported so the rule lands in this (consuming) stack, like the DB rule.
      const lagunaSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'LagunaSgImport',
        lagunaSecurityGroup.securityGroupId,
        { allowAllOutbound: false, mutable: true },
      );
      lagunaSgLocal.addIngressRule(
        agent.securityGroup,
        ec2.Port.tcp(lagunaMcpPort),
        'whatsapp-agent to laguna customer MCP',
      );
    }
  }
}
