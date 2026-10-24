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


// The relayed-edge-telemetry path (docs/cloud-alloy-template.md): edge boxes POST
// to the backend, which stamps tenant identity and forwards the export to a
// DEDICATED Alloy receiver over task loopback. The invariants below are the ones
// that are expensive to discover in production — a relay port reachable from the
// ENI, edge telemetry silently entering the cloud service's own pipeline (and so
// wearing its labels), or an unbounded queue OOM-killing a sidecar that is
// non-essential and therefore dies quietly.
// Backend v1.2.0 made the cloud multi-tenant: the organization comes from each caller,
// and config.NewConfig(cloud) refuses to boot on the old single-tenant env.
describe('ServicesStack — multi-tenant cloud config', () => {
  const { template } = synthServices();

  const app = (t = template) =>
    (Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as any).Properties
      .ContainerDefinitions.find((c: any) => c.Name === 'app');
  const envOf = (t = template): Record<string, string> =>
    Object.fromEntries(app(t).Environment.map((e: any) => [e.Name, e.Value]));
  const secretNames = (t = template): string[] => app(t).Secrets.map((s: any) => s.Name);

  test('ORGANIZATION_ID is not set: the cloud fatals if it is', () => {
    assert.ok(!('ORGANIZATION_ID' in envOf()));
    assert.ok(!secretNames().includes('ORGANIZATION_ID'));
  });

  test('NODE_ID is the cloud id Laguna\'s box derives, so its sync_state stays valid', () => {
    // uuid5(NAMESPACE_URL, "laguna-escondida/node/<laguna org>/cloud")
    assert.equal(envOf().NODE_ID, '45598059-e12e-530c-86b6-758477c4423d');
  });

  test('relayed edge telemetry lands in Laguna\'s tenant (required with the forward URL)', () => {
    assert.equal(envOf().TELEMETRY_TENANT_ID, 'bb0cad3e-be13-4bad-9a37-bba9525bfece');
  });

  test('no tenant id without the relay', () => {
    const { template: noAlloy } = synthServices({ lagunaAlloy: 'off' });
    assert.ok(!('TELEMETRY_TENANT_ID' in envOf(noAlloy)));
  });

  test('invoice prefixes are per-organization rows now, not env', () => {
    assert.ok(!secretNames().includes('ELECTRONIC_INVOICE_PREFIX'));
    assert.ok(!secretNames().includes('SUPPORT_DOCUMENT_PREFIX'));
  });
});

describe('ServicesStack — edge telemetry relay', () => {
  const { template } = synthServices();

  // The Alloy config is a plain (untokenized) string on the sidecar's
  // ALLOY_CONFIG env var, so it can be asserted directly. That matters for the
  // NEGATIVE checks below: `Match` can assert a value is present, but not that a
  // dangerous one is absent.
  const alloyConfig = (): string => {
    const taskDef = Object.values(
      template.findResources('AWS::ECS::TaskDefinition'),
    )[0] as any;
    const alloy = taskDef.Properties.ContainerDefinitions.find(
      (c: any) => c.Name === 'alloy',
    );
    assert.ok(alloy, 'no alloy container in the task definition');
    const cfg = alloy.Environment.find((e: any) => e.Name === 'ALLOY_CONFIG');
    assert.ok(cfg, 'alloy container has no ALLOY_CONFIG env var');
    return cfg.Value as string;
  };

  // The negative assertions below ("no 0.0.0.0", "no 4318") are about what Alloy
  // is CONFIGURED to do, so the prose has to go first — the comments in that file
  // name both strings precisely to explain why they're absent. `//` is only
  // stripped at start-of-line or after whitespace, so a `https://` in a value
  // survives.
  const alloyDirectives = (): string =>
    alloyConfig()
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');

  const appEnv = (t = template): Array<{ Name: string; Value: string }> => {
    const taskDef = Object.values(
      t.findResources('AWS::ECS::TaskDefinition'),
    )[0] as any;
    return taskDef.Properties.ContainerDefinitions.find(
      (c: any) => c.Name === 'app',
    ).Environment;
  };

  test('app forwards relayed edge telemetry to the sidecar over loopback', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          Environment: Match.arrayWith([
            { Name: 'TELEMETRY_FORWARD_URL', Value: 'http://127.0.0.1:4319' },
          ]),
        }),
      ]),
    });
  });

  test('forward URL is unset when the alloy sidecar is switched off', () => {
    // `cdk deploy -c lagunaAlloy=off` drops the sidecar. If the app still
    // advertised its ingest routes it would forward into a void: every edge POST
    // 502s and the boxes spin on retry. The env var must follow the sidecar.
    const { template: noAlloy } = synthServices({ lagunaAlloy: 'off' });
    const names = appEnv(noAlloy).map((e) => e.Name);
    assert.ok(
      !names.includes('TELEMETRY_FORWARD_URL'),
      'TELEMETRY_FORWARD_URL must not be set when alloy is off',
    );
  });

  test('relay receiver binds loopback only, never the task ENI', () => {
    // The task runs in a PUBLIC subnet with a public IP, so loopback binding is
    // the only thing keeping the unauthenticated relay port off the internet.
    const cfg = alloyDirectives();
    assert.match(cfg, /127\.0\.0\.1:4319/);
    assert.doesNotMatch(cfg, /0\.0\.0\.0/);
  });

  test('app OTLP receiver is gRPC-only, so 4318 cannot be mistaken for the relay', () => {
    // The app exports over gRPC (:4317). A second, unused OTLP/HTTP door on :4318
    // would accept a mistyped TELEMETRY_FORWARD_URL and route edge telemetry
    // through the CLOUD pipeline — mislabelled, and it would look like it worked.
    assert.doesNotMatch(alloyDirectives(), /4318/);
  });

  test('relay owns its exporter so an edge burst cannot evict app telemetry', () => {
    // One exporter component means one queue and one backoff shared by both
    // pipelines. Separate instances (sharing only the auth handler) keep an edge
    // burst from starving the cloud service's own telemetry.
    assert.match(alloyDirectives(), /otelcol\.exporter\.otlphttp "edge_relay"/);
  });

  test('queues are bounded and retry never gives up on a Grafana outage', () => {
    // Absorbing an outage is the whole point of relaying through Alloy, and the
    // exporter default (max_elapsed_time ~5m) drops data instead. "0s" = retry
    // forever; the bounded queue is what stops that from growing without limit.
    const cfg = alloyDirectives();
    assert.match(cfg, /queue_size\s*=/);
    assert.match(cfg, /max_elapsed_time\s*=\s*"0s"/);
  });

  test('alloy stays hard-capped at 256 MiB inside the 1024 MiB task', () => {
    // Deliberate: no memory bump for the relay. The cap is what forces the
    // bounded queue + memory limiter above, and keeps Alloy from starving the
    // app. Revisit from real usage, not from a guess about node count.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Memory: '1024',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'alloy', Memory: 256 }),
      ]),
    });
  });

  test('a memory limiter refuses data instead of letting the sidecar OOM', () => {
    // Alloy is non-essential: an OOM kill removes it silently and every
    // subsequent edge forward gets connection-refused. Refusing at the receiver
    // pushes back to the edge (which has its own disk buffer) and stays alive.
    assert.match(alloyDirectives(), /otelcol\.processor\.memory_limiter/);
  });
});

// The customer MCP server (laguna-escondida-backend cmd/mcp-server, MCP_TOOLSET=
// customer) the WhatsApp agent takes orders through. A sidecar of the laguna task:
// same image and release as the backend it fronts, reached over task loopback,
// no extra task or public IP. Its safety rests on three things pinned here: only
// the customer toolset, the `agent`-role credentials and the bearer token as
// secrets, and no way for it to take the backend down with it.
describe('ServicesStack — customer MCP sidecar', () => {
  const { template } = synthServices();

  type Container = {
    Name: string;
    Image?: unknown;
    Command?: string[];
    Essential?: boolean;
    Memory?: number;
    PortMappings?: Array<{ ContainerPort: number }>;
    Environment?: Array<{ Name: string; Value: unknown }>;
    Secrets?: Array<{ Name: string }>;
    HealthCheck?: { Command: string[] };
  };
  const containers = (t = template): Container[] =>
    (Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as any).Properties
      .ContainerDefinitions;
  const mcp = (): Container => {
    const c = containers().find((x) => x.Name === 'mcp-customer');
    assert.ok(c, 'no mcp-customer container in the task definition');
    return c;
  };
  const env = (c: Container) =>
    Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));

  test('runs the backend image as ./mcp-server, same release as the app', () => {
    const app = containers().find((x) => x.Name === 'app')!;
    assert.deepEqual(JSON.stringify(mcp().Image), JSON.stringify(app.Image));
    assert.deepEqual(mcp().Command, ['./mcp-server']);
  });

  test('serves only the customer toolset, against the backend over loopback', () => {
    const e = env(mcp());
    assert.equal(e.MCP_TOOLSET, 'customer');
    assert.equal(e.LAGUNA_API_URL, 'http://127.0.0.1:8080');
    assert.equal(e.MCP_ADDR, ':8090');
    assert.deepEqual(mcp().PortMappings?.map((p) => p.ContainerPort), [8090]);
  });

  test('agent credentials and bearer token are secrets, never plaintext env', () => {
    const names = (mcp().Secrets ?? []).map((s) => s.Name);
    for (const name of ['LAGUNA_USERNAME', 'LAGUNA_PASSWORD', 'MCP_AUTH_TOKEN']) {
      assert.ok(names.includes(name), `${name} must be a secret`);
      assert.ok(!(name in env(mcp())), `${name} must not be plaintext env`);
    }
    // The admin key unlocks admin-only endpoints the customer toolset never calls.
    assert.ok(!names.includes('LAGUNA_ADMIN_API_KEY'));
  });

  test('is non-essential and capped, so it can never take laguna down', () => {
    assert.equal(mcp().Essential, false);
    assert.equal(mcp().Memory, 128);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Memory: '1024' });
  });

  test('health-checks its own /health with wget (alpine image)', () => {
    assert.match(mcp().HealthCheck!.Command.join(' '), /wget .*localhost:8090\/health/);
  });

  test('no 8090 ingress in this stack: the consumer opens it (MarketingStack)', () => {
    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'));
    assert.ok(!rules.some((r: any) => r.Properties.FromPort === 8090));
  });

  test('lagunaMcp=off drops the sidecar', () => {
    const { template: off } = synthServices({ lagunaMcp: 'off' });
    assert.ok(!containers(off).some((c) => c.Name === 'mcp-customer'));
  });
});
