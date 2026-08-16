import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthServices } from './support/harness';

// The laguna service is where the Path-B observability services (Loki/Grafana/
// Prometheus) will eventually be modeled the same way. These tests lock in the
// cost + fail-fast + boot-correctness invariants baked into services-stack.ts and
// the EcsService construct, so a refactor can't silently regress them.
describe('ServicesStack — laguna', () => {
  const { template } = synthServices();

  test('runs a single ECS service on FARGATE_SPOT (cost invariant)', () => {
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
      ]),
    });
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
