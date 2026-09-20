import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthServices } from './support/harness';

// The laguna service is where the Path-B observability services (Loki/Grafana/
// Prometheus) will eventually be modeled the same way. These tests lock in the
// cost + fail-fast + boot-correctness invariants baked into services-stack.ts and
// the EcsService construct, so a refactor can't silently regress them.
describe('ServicesStack — laguna', () => {
  const { template } = synthServices();

  test('runs 4 ECS services, all on FARGATE_SPOT (cost invariant)', () => {
    // laguna + the three microbiome services (api, worker, ui). Every service
    // must be on Spot — the whole point of this app is cost-optimized infra.
    template.resourceCountIs('AWS::ECS::Service', 4);
    const services = template.findResources('AWS::ECS::Service');
    for (const [id, svc] of Object.entries(services)) {
      const strategy = (svc as any).Properties.CapacityProviderStrategy;
      assert.ok(
        Array.isArray(strategy) &&
          strategy.some((s: any) => s.CapacityProvider === 'FARGATE_SPOT'),
        `${id} must run on FARGATE_SPOT`,
      );
    }
  });

  test('deployment circuit breaker rolls back a bad boot', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
      EnableExecuteCommand: true,
    });
  });

  test('task def is 256 CPU / 1024 MB (tunnel sidecar doubles memory)', () => {
    // hasTunnel === true here (cfTunnelTokenSecret is wired), so memory 512 -> 1024.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '1024',
    });
  });

  test('app container runs cloud mode over SSL and health-checks /api/health', () => {
    // Assert each env var independently: Match.arrayWith is order-sensitive, and
    // the container emits these in a different order than we'd list them. A
    // single-element arrayWith just checks presence, so it's robust to reordering.
    const appEnvHas = (entry: { Name: string; Value: string }) =>
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'app', Environment: Match.arrayWith([entry]) }),
        ]),
      });

    appEnvHas({ Name: 'APP_MODE', Value: 'cloud' });
    appEnvHas({ Name: 'PORT', Value: '8080' });
    appEnvHas({ Name: 'DB_SSLMODE', Value: 'require' });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          HealthCheck: Match.objectLike({
            Command: Match.arrayWith([Match.stringLikeRegexp('/api/health')]),
          }),
        }),
      ]),
    });
  });

  test('ships a cloudflared tunnel sidecar alongside the app', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'cloudflared' }),
      ]),
    });
  });

  test('ships a Grafana Alloy telemetry sidecar that is non-essential', () => {
    // Non-essential is the invariant that matters: a telemetry outage (Alloy
    // crash/OOM) must never take the app container — and thus the service — down.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'alloy', Essential: false }),
      ]),
    });
  });

  test('alloy sidecar health-checks its own /-/ready endpoint', () => {
    // The Alloy image ships bash but NO wget/curl, so the check hits the built-in
    // readiness endpoint on 127.0.0.1:12345 over bash's /dev/tcp (verified in prod).
    // Alloy is non-essential, so an UNHEALTHY result is visibility only — it flips
    // the ECS health field off UNKNOWN but never triggers task replacement.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'alloy',
          HealthCheck: Match.objectLike({
            Command: Match.arrayWith([Match.stringLikeRegexp('/-/ready')]),
          }),
        }),
      ]),
    });
  });

  test('cloudflared pins its metrics port so /ready is deterministic', () => {
    // The cloudflared image is DISTROLESS (no shell, no HTTP client) so it can't run
    // a native ECS container healthcheck. Pinning --metrics makes its /ready endpoint
    // land on a fixed port instead of a random one, so a neighbor container (shared
    // netns) — or a devops agent via ECS Exec — can probe tunnel readiness.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'cloudflared',
          Command: Match.arrayWith(['--metrics', '127.0.0.1:2000']),
        }),
      ]),
    });
  });

  test('alloy receives the Grafana Cloud token as a secret, never plaintext', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'alloy',
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'GRAFANA_CLOUD_OTLP_TOKEN' }),
          ]),
        }),
      ]),
    });
  });

  test('app is pointed at the alloy sidecar for OTLP export', () => {
    const appEnvHas = (entry: { Name: string; Value: string }) =>
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'app', Environment: Match.arrayWith([entry]) }),
        ]),
      });

    appEnvHas({ Name: 'OBSERVABILITY_ENABLED', Value: 'true' });
    appEnvHas({ Name: 'OTEL_EXPORTER_OTLP_ENDPOINT', Value: 'http://127.0.0.1:4317' });
  });

  test('DB secret is injected, never inlined as plaintext env', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'DB_PASSWORD' }),
          ]),
        }),
      ]),
    });
  });

  test('log group retains one week and is destroyed with the stack', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/laguna',
      RetentionInDays: 7,
    });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });

  test('opens Postgres (5432) from the service to the DB security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('registers laguna in Cloud Map for internal DNS', () => {
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      Name: 'laguna',
    });
  });
});

// microbiome-lab: api + worker (SQS between them) + ui. These tests pin the
// per-service invariants the plan calls out — the discriminators that a refactor
// could silently break (worker has no public tunnel, api uses the task role for
// SQS, least-privilege queue grants, DB creds always injected as secrets).
describe('ServicesStack — microbiome-lab', () => {
  const { template } = synthServices();

  // Every service's `app` container carries SERVICE_NAME (injected by the
  // EcsService construct), so we can locate a task def by service without relying
  // on the synthesized logical id.
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  function byService(name: string) {
    for (const def of Object.values(taskDefs)) {
      const containers = (def as any).Properties.ContainerDefinitions as any[];
      const app = containers.find((c) => c.Name === 'app');
      const svc = app?.Environment?.find(
        (e: any) => e.Name === 'SERVICE_NAME',
      )?.Value;
      if (svc === name) return { containers, app };
    }
    throw new Error(`no task def found for service ${name}`);
  }
  const appEnv = (app: any) =>
    Object.fromEntries(
      (app.Environment as any[]).map((e) => [e.Name, e.Value]),
    );

  test('api + ui ship a cloudflared tunnel sidecar; the worker does not', () => {
    const hasCloudflared = (svc: string) =>
      byService(svc).containers.some((c) => c.Name === 'cloudflared');
    assert.ok(hasCloudflared('microbiome-api'), 'api needs a public tunnel');
    assert.ok(hasCloudflared('microbiome-ui'), 'ui needs a public tunnel');
    assert.equal(
      hasCloudflared('microbiome-worker'),
      false,
      'worker is SQS-only — no public ingress, no sidecar',
    );
  });

  test('worker listens on 8081 and health-checks /api/health; api listens on 8080', () => {
    const worker = byService('microbiome-worker').app;
    assert.equal(worker.PortMappings[0].ContainerPort, 8081);
    assert.match(worker.HealthCheck.Command.join(' '), /localhost:8081\/api\/health/);

    const api = byService('microbiome-api').app;
    assert.equal(api.PortMappings[0].ContainerPort, 8080);
    assert.match(api.HealthCheck.Command.join(' '), /localhost:8080\/api\/health/);
  });

  test('api env: DB_SSLMODE=require, SQS_QUEUE_URL set, and NO static AWS creds', () => {
    const env = appEnv(byService('microbiome-api').app);
    assert.equal(env.DB_SSLMODE, 'require');
    assert.equal(env.DB_NAME, 'microbiome_lab');
    assert.ok('SQS_QUEUE_URL' in env, 'api must know the queue URL');
    // Leaving AWS_ACCESS_KEY_ID unset makes the SDK fall back to the task role —
    // static creds in env would defeat least-privilege and never rotate.
    assert.ok(!('AWS_ACCESS_KEY_ID' in env), 'must use the task role, not static keys');
    assert.ok(!('AWS_ENDPOINT_URL' in env), 'AWS_ENDPOINT_URL is LocalStack-only');
  });

  test('ui reaches the api internally over Cloud Map (no DB, no queue)', () => {
    const env = appEnv(byService('microbiome-ui').app);
    assert.match(env.API_BASE_URL, /microbiome-api\.bryan-test\.local:8080/);
    assert.ok(!('SQS_QUEUE_URL' in env), 'ui does not touch the queue');
    assert.ok(!('DB_HOST' in env), 'ui does not touch the DB');
  });

  test('api task role may SendMessage; worker may Receive/Delete on the samples queue', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['sqs:SendMessage']) }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
          }),
        ]),
      },
    });
  });

  test('DB creds are injected as secrets (never plaintext) on api + worker', () => {
    const apiSecrets = byService('microbiome-api').app.Secrets.map((s: any) => s.Name);
    const workerSecrets = byService('microbiome-worker').app.Secrets.map(
      (s: any) => s.Name,
    );
    assert.ok(apiSecrets.includes('DB_PASSWORD'));
    assert.ok(workerSecrets.includes('DB_PASSWORD'));
    // Worker serves no ingest route, so it must NOT hold the ingest token.
    assert.ok(apiSecrets.includes('INGEST_API_TOKEN'), 'api needs the ingest token');
    assert.ok(
      !workerSecrets.includes('INGEST_API_TOKEN'),
      'worker must not hold the ingest token',
    );
  });

  test('Postgres ingress (5432) is opened for api + worker, but not ui', () => {
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    const descriptions = Object.values(ingress)
      .filter((r: any) => r.Properties.FromPort === 5432)
      .map((r: any) => r.Properties.Description as string);
    assert.ok(descriptions.some((d) => d?.includes('microbiome-api')));
    assert.ok(descriptions.some((d) => d?.includes('microbiome-worker')));
    assert.ok(
      !descriptions.some((d) => d?.includes('microbiome-ui')),
      'ui has no DB access',
    );
  });

  test('samples queue has a DLQ wired with maxReceiveCount 5', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'microbiome-lab-samples',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'microbiome-lab-samples-dlq',
    });
  });

  test('microbiome services carry no static AWS credentials as secrets', () => {
    // Belt-and-suspenders on the task-role posture: neither key should ever be a
    // secret ref either (which would also short-circuit the SDK's role lookup).
    for (const svc of ['microbiome-api', 'microbiome-worker']) {
      const names = byService(svc).app.Secrets.map((s: any) => s.Name);
      assert.ok(!names.includes('AWS_ACCESS_KEY_ID'));
      assert.ok(!names.includes('AWS_SECRET_ACCESS_KEY'));
    }
  });
});
