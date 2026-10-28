import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthCi, synthConsole, synthDbAdmin, synthEcr } from './support/harness';

// marketing-app's operations console: console-api serving the built console-web
// from one origin (its session cookie is SameSite=Strict). Its own stack so a
// console deploy never rolls the WhatsApp agent. These tests pin what would
// otherwise only show up as a failed boot, a hung deploy or a leaked secret.

type ContainerDef = {
  Name: string;
  Environment?: Array<{ Name: string; Value: unknown }>;
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
  HealthCheck?: { Command: string[] };
  PortMappings?: Array<{ ContainerPort: number }>;
  Image?: unknown;
};

const container = (template: ReturnType<typeof synthConsole>['template'], name: string) => {
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1, 'expected exactly one task definition');
  const c = ((taskDefs[0] as any).Properties.ContainerDefinitions as ContainerDef[]).find(
    (x) => x.Name === name,
  );
  assert.ok(c, `no ${name} container in the task definition`);
  return c;
};

const envOf = (c: ContainerDef): Record<string, unknown> =>
  Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));

const secretNames = (c: ContainerDef): string[] => (c.Secrets ?? []).map((s) => s.Name);

const literal = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : JSON.stringify(v).replace(/\{"Fn::ImportValue":"[^"]*"\}/g, '<token>');

describe('ConsoleStack — console-api service', () => {
  const { template } = synthConsole();

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

  test('is not registered in Cloud Map (reached only through the tunnel)', () => {
    template.resourceCountIs('AWS::ServiceDiscovery::Service', 0);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceRegistries: Match.absent(),
    });
  });

  test('runs the console-api image at its own release tag', () => {
    const image = JSON.stringify(container(template, 'app').Image);
    assert.match(image, /ConsoleApiRepo/);
    assert.match(image, /:v0\.2\.0"/);
  });

  test('app health check runs the binary itself (image is distroless)', () => {
    assert.deepEqual(container(template, 'app').HealthCheck?.Command, [
      'CMD',
      '/app/console-api',
      'healthcheck',
    ]);
  });

  test('listens on 8090 and serves the bundled web app', () => {
    const app = container(template, 'app');
    assert.equal(envOf(app).PORT, '8090');
    assert.ok(app.PortMappings?.some((p) => p.ContainerPort === 8090));
    // The image sets CONSOLE_WEB_DIR; overriding it here would serve the API only.
    assert.ok(!('CONSOLE_WEB_DIR' in envOf(app)));
  });

  test('never runs with the dev-only insecure cookie', () => {
    assert.ok(!('CONSOLE_DEV_INSECURE_COOKIE' in envOf(container(template, 'app'))));
  });

  test('connects as its own login role over SSL, password only via PGPASSWORD', () => {
    // Not marketing_svc: the console holds marketing_console, the agent does not.
    const app = container(template, 'app');
    const url = literal(envOf(app).DATABASE_URL);
    assert.match(url, /postgres:\/\/marketing_console_svc@/);
    assert.match(url, /\/marketing\?sslmode=require/);
    assert.doesNotMatch(url, /marketing_console_svc:/);
    assert.ok(secretNames(app).includes('PGPASSWORD'));
  });

  test('the provisioning token is a secret, never plaintext env', () => {
    const app = container(template, 'app');
    assert.ok(secretNames(app).includes('CONSOLE_PROVISION_TOKEN'));
    assert.ok(!('CONSOLE_PROVISION_TOKEN' in envOf(app)));
  });

  test('seals tool-server and channel secrets with the public half only', () => {
    const app = container(template, 'app');
    assert.ok(secretNames(app).includes('SECRETS_PUBLIC_KEY'));
    // whatsapp-agent alone can open what the console seals.
    assert.ok(!secretNames(app).includes('SECRETS_PRIVATE_KEY'));
  });

  test('throttles sign-in by the client address Cloudflare reports', () => {
    // Every connection arrives from cloudflared on loopback.
    assert.equal(
      envOf(container(template, 'app')).CONSOLE_CLIENT_IP_HEADER,
      'CF-Connecting-IP',
    );
  });

  test('ships a cloudflared sidecar reading its token from the infra secret', () => {
    assert.ok(secretNames(container(template, 'cloudflared')).includes('TUNNEL_TOKEN'));
  });

  test('opens Postgres (5432) from the service to the DB security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('accepts no inbound traffic of its own', () => {
    // The tunnel dials out; the task runs in a public subnet with a public IP, so
    // an ingress rule would put /internal/provision on the internet.
    const sgs = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
    for (const sg of sgs) {
      assert.equal((sg as any).Properties.SecurityGroupIngress, undefined);
    }
    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'));
    assert.ok(rules.every((r: any) => r.Properties.FromPort === 5432));
  });

  test('log group is /ecs/console-api', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/ecs/console-api' });
  });
});

describe('ConsoleStack — escape hatches', () => {
  test('consoleDesiredCount=0 parks the service', () => {
    const { template } = synthConsole({ consoleDesiredCount: 0 });
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
  });

  test('consoleTunnel=off drops cloudflared and stops trusting its header', () => {
    const { template } = synthConsole({ consoleTunnel: 'off' });
    assert.ok(!('CONSOLE_CLIENT_IP_HEADER' in envOf(container(template, 'app'))));
    const taskDef = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    assert.ok(
      !taskDef.Properties.ContainerDefinitions.some((c: ContainerDef) => c.Name === 'cloudflared'),
    );
  });
});

describe('EcrStack — console repo', () => {
  test('console-api repo is retained', () => {
    synthEcr().template.hasResource('AWS::ECR::Repository', {
      Properties: Match.objectLike({ RepositoryName: 'console-api' }),
      DeletionPolicy: 'Retain',
    });
  });
});

describe('CiStack — marketing-app release role pushes the console image', () => {
  test('the marketing push role can push to console-api', () => {
    const { template } = synthCi();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    assert.match(policies, /ConsoleApiRepo/);
  });
});

describe('DbAdminStack — console login role', () => {
  test('admin task can set the console role password from its secret', () => {
    const { template } = synthDbAdmin();
    const admin = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((td) => (td as any).Properties.ContainerDefinitions as ContainerDef[])
      .find((c) => c.Name === 'dbadmin');
    assert.ok(admin);
    assert.ok(secretNames(admin).includes('MARKETING_CONSOLE_DB_PASSWORD'));
  });
});
