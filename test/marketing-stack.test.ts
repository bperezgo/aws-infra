import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  synthCi,
  synthDbAdmin,
  synthEcr,
  synthMarketing,
} from './support/harness';

// The whatsapp-agent (marketing-app repo) lives in its own stack so deploying it
// never touches laguna. Its image is DISTROLESS, its DB access goes through
// grant-holder roles defined by the app's migrations, and its telemetry fans out
// through Alloy to Grafana Cloud and Langfuse. These tests pin the
// details that would otherwise only show up as a failed boot or a leaked secret.

type ContainerDef = {
  Name: string;
  Environment?: Array<{ Name: string; Value: unknown }>;
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
  HealthCheck?: unknown;
  Essential?: boolean;
  Command?: unknown[];
  Image?: unknown;
};

const containers = (template: Template): ContainerDef[] => {
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1, 'expected exactly one task definition');
  return (taskDefs[0] as any).Properties.ContainerDefinitions;
};

const container = (template: Template, name: string): ContainerDef => {
  const c = containers(template).find((x) => x.Name === name);
  assert.ok(c, `no ${name} container in the task definition`);
  return c;
};

const envOf = (c: ContainerDef): Record<string, unknown> =>
  Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));

const secretNames = (c: ContainerDef): string[] => (c.Secrets ?? []).map((s) => s.Name);

// Flatten a CFN value (string or Fn::Join) to its literal parts so a DATABASE_URL
// built from a token-valued RDS endpoint can still be pattern-matched.
const literal = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : JSON.stringify(v).replace(/\{"Fn::ImportValue":"[^"]*"\}/g, '<token>');

const alloyDirectives = (template: Template): string => {
  const cfg = envOf(container(template, 'alloy')).ALLOY_CONFIG;
  assert.equal(typeof cfg, 'string', 'ALLOY_CONFIG must be a plain string');
  return (cfg as string)
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
};

describe('MarketingStack — whatsapp-agent service', () => {
  const { template } = synthMarketing();

  test('one Fargate Spot service, circuit breaker on, ECS Exec on', () => {
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
      ]),
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
      EnableExecuteCommand: true,
    });
  });

  test('is not registered in Cloud Map (nothing calls it inside the VPC)', () => {
    // Meta reaches it through the tunnel. A registration would also make every
    // deploy wait on the Cloud Map instance turning healthy.
    template.resourceCountIs('AWS::ServiceDiscovery::Service', 0);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceRegistries: Match.absent(),
    });
  });

  test('task def is 256 CPU / 1024 MB with sidecars', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '1024',
    });
  });

  test('app health check runs the binary itself (image is distroless)', () => {
    // gcr.io/distroless/static has no /bin/sh and no wget: a CMD-SHELL check can
    // never pass, so the check is exec-form and probes liveness, not readiness.
    const hc = container(template, 'app').HealthCheck as { Command: string[] };
    assert.deepEqual(hc.Command, ['CMD', '/app/whatsapp-agent', 'healthcheck']);
  });

  test('connects as marketing_svc over SSL, password only via PGPASSWORD secret', () => {
    const app = container(template, 'app');
    const url = literal(envOf(app).DATABASE_URL);
    assert.match(url, /postgres:\/\/marketing_svc@/);
    assert.match(url, /\/marketing\?sslmode=require/);
    // No "user:password@" form — the password is never in the URL.
    assert.doesNotMatch(url, /marketing_svc:/);
    assert.ok(secretNames(app).includes('PGPASSWORD'));
  });

  test('model and WhatsApp credentials are secrets, never plaintext env', () => {
    const app = container(template, 'app');
    const env = envOf(app);
    for (const name of [
      'ANTHROPIC_API_KEY',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
    ]) {
      assert.ok(secretNames(app).includes(name), `${name} must be a secret`);
      assert.ok(!(name in env), `${name} must not be plaintext env`);
    }
  });

  test('model tuning and staff escalation number come from the app secret', () => {
    // Optional to the app but set in the secret: a key the task def doesn't name
    // never reaches the container (escalations silently fell back to the public
    // contact).
    const app = container(template, 'app');
    const env = envOf(app);
    for (const name of ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'STAFF_WHATSAPP_LAGUNA_ESCONDIDA']) {
      assert.ok(secretNames(app).includes(name), `${name} must be injected from the secret`);
      assert.ok(!(name in env), `${name} must not be plaintext env`);
    }
  });

  test('app holds no telemetry-backend credentials (Alloy does)', () => {
    const names = secretNames(container(template, 'app')).join(',');
    assert.doesNotMatch(names, /GRAFANA|LANGFUSE/);
  });

  test('fails safe on customer data: serve readiness, no content in telemetry', () => {
    const env = envOf(container(template, 'app'));
    assert.equal(env.PRODUCT_READINESS, 'serve');
    assert.equal(env.TELEMETRY_CONTENT, 'none');
    assert.equal(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, 'false');
  });

  test('exports OTLP/HTTP to the alloy sidecar over loopback', () => {
    const env = envOf(container(template, 'app'));
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
    assert.equal(env.OTEL_SERVICE_NAME, 'whatsapp-agent');
    assert.match(String(env.OTEL_RESOURCE_ATTRIBUTES), /service\.version=v0\.1\.0/);
  });

  test('labels telemetry as the production marketing service, apart from laguna', () => {
    const attrs = String(envOf(container(template, 'app')).OTEL_RESOURCE_ATTRIBUTES);
    assert.match(attrs, /(^|,)service\.namespace=marketing(,|$)/);
    // The cdk.json `env` ("dev") names the stacks; this deployment serves real
    // customers, so its telemetry says production regardless.
    assert.match(attrs, /(^|,)deployment\.environment\.name=production(,|$)/);
  });

  test('ships a cloudflared sidecar reading its token from the infra secret', () => {
    assert.ok(secretNames(container(template, 'cloudflared')).includes('TUNNEL_TOKEN'));
  });

  test('alloy is non-essential and holds the Grafana Cloud creds', () => {
    const alloy = container(template, 'alloy');
    assert.equal(alloy.Essential, false);
    assert.ok(secretNames(alloy).includes('GRAFANA_CLOUD_OTLP_TOKEN'));
  });

  test('alloy receiver binds loopback only, never the public task ENI', () => {
    const cfg = alloyDirectives(template);
    assert.match(cfg, /127\.0\.0\.1:4318/);
    assert.doesNotMatch(cfg, /0\.0\.0\.0/);
  });

  test('alloy queues are bounded and protected by a memory limiter', () => {
    const cfg = alloyDirectives(template);
    assert.match(cfg, /otelcol\.processor\.memory_limiter/);
    assert.match(cfg, /queue_size\s*=/);
  });

  test('alloy keeps idle OTLP connections open longer than the 60s metric interval', () => {
    // Alloy's default idle_timeout is 1m, exactly the Go SDK's export interval:
    // the app reuses a keep-alive connection just as Alloy closes it, and that
    // minute of metrics is lost ("connection reset by peer").
    const m = alloyDirectives(template).match(/idle_timeout\s*=\s*"(\d+)m"/);
    assert.ok(m, 'otlp receiver must set idle_timeout');
    assert.ok(Number(m[1]) > 1, `idle_timeout ${m[1]}m must exceed the 1m export interval`);
  });

  test('Langfuse is on by default: traces fan out to it, keys on Alloy only', () => {
    // On in code, not a deploy flag: a flag left off one `cdk deploy` silently
    // dropped the branch from production.
    const cfg = alloyDirectives(template);
    assert.match(cfg, /otelcol\.exporter\.otlphttp "langfuse"/);
    // Traces fan out to both destinations; Langfuse's renames stay on its branch.
    assert.match(cfg, /otelcol\.processor\.transform\.langfuse\.input/);
    assert.match(cfg, /otelcol\.exporter\.otlphttp\.grafana_cloud\.input/);
    const alloySecrets = secretNames(container(template, 'alloy'));
    for (const k of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_OTLP_ENDPOINT']) {
      assert.ok(alloySecrets.includes(k), `alloy needs ${k}`);
    }
  });

  test('opens Postgres (5432) from the service to the DB security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('log group is /ecs/whatsapp-agent', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/whatsapp-agent',
    });
  });
});

describe('MarketingStack — escape hatches', () => {
  test('whatsappAgentLangfuse=off drops the Langfuse exporter and its keys', () => {
    const { template } = synthMarketing({ whatsappAgentLangfuse: 'off' });
    assert.doesNotMatch(alloyDirectives(template), /langfuse/i);
    assert.doesNotMatch(secretNames(container(template, 'alloy')).join(','), /LANGFUSE/);
  });

  test('whatsappAgentAlloy=off drops the sidecar AND the OTLP endpoint', () => {
    // Unset OTLP endpoint is the app's "no telemetry" switch; leaving it set with
    // no collector would just log export failures forever.
    const { template } = synthMarketing({ whatsappAgentAlloy: 'off' });
    assert.ok(!containers(template).some((c) => c.Name === 'alloy'));
    assert.ok(!('OTEL_EXPORTER_OTLP_ENDPOINT' in envOf(container(template, 'app'))));
  });

  test('whatsappAgentTunnel=off drops cloudflared', () => {
    const { template } = synthMarketing({ whatsappAgentTunnel: 'off' });
    assert.ok(!containers(template).some((c) => c.Name === 'cloudflared'));
  });

  test('whatsappAgentDesiredCount=0 parks the service', () => {
    const { template } = synthMarketing({ whatsappAgentDesiredCount: 0 });
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
  });

  test('whatsappAgentReadiness only accepts serve|develop', () => {
    const { template } = synthMarketing({ whatsappAgentReadiness: 'develop' });
    assert.equal(envOf(container(template, 'app')).PRODUCT_READINESS, 'develop');
    assert.throws(() => synthMarketing({ whatsappAgentReadiness: 'yolo' }), /serve|develop/);
  });
});

describe('EcrStack — marketing repos', () => {
  const { template } = synthEcr();

  test('whatsapp-agent and marketing-migrations repos are retained', () => {
    for (const name of ['whatsapp-agent', 'marketing-migrations']) {
      template.hasResource('AWS::ECR::Repository', {
        Properties: Match.objectLike({ RepositoryName: name }),
        DeletionPolicy: 'Retain',
      });
    }
  });
});

describe('CiStack — marketing-app release role', () => {
  const { template } = synthCi();

  // marketing-app's OIDC tokens use GitHub's immutable subject format
  // (owner@ownerId/repo@repoId), not the legacy owner/repo form laguna uses.
  test('only v* tags of the marketing-app repo can assume the push role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'gha-marketing-ecr-push',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub':
                  'repo:test-owner@42921391/marketing-app@1377597523:ref:refs/tags/v*',
              },
            }),
          }),
        ]),
      },
    });
  });
});

describe('DbAdminStack — marketing migrations task', () => {
  const { template } = synthDbAdmin();

  const migrate = (): ContainerDef => {
    for (const td of Object.values(template.findResources('AWS::ECS::TaskDefinition'))) {
      const c = (td as any).Properties.ContainerDefinitions.find(
        (x: ContainerDef) => x.Name === 'migrate',
      );
      if (c) return c;
    }
    assert.fail('no migrate container in the dbadmin stack');
  };

  test('runs migrate up as the database owner, password via PGPASSWORD secret', () => {
    const c = migrate();
    const cmd = literal(c.Command);
    assert.match(cmd, /postgres:\/\/marketing_owner@/);
    assert.match(cmd, /sslmode=require/);
    assert.match(cmd, /"up"/);
    assert.doesNotMatch(cmd, /marketing_owner:/);
    assert.ok(secretNames(c).includes('PGPASSWORD'));
  });

  test('uses the marketing-migrations image at the whatsapp-agent release tag', () => {
    const image = JSON.stringify(migrate().Image);
    assert.match(image, /MarketingMigrationsRepo/);
    assert.match(image, /:v0\.1\.0"/);
  });

  test('admin task can set both marketing role passwords from secrets', () => {
    const admin = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((td) => (td as any).Properties.ContainerDefinitions as ContainerDef[])
      .find((c) => c.Name === 'dbadmin');
    assert.ok(admin);
    const names = secretNames(admin);
    assert.ok(names.includes('MARKETING_OWNER_DB_PASSWORD'));
    assert.ok(names.includes('MARKETING_SVC_DB_PASSWORD'));
  });

  test('exports the migrate task def for scripts/db/migrate-marketing.sh', () => {
    template.hasOutput('MarketingMigrateTaskDefArn', {});
  });
});
