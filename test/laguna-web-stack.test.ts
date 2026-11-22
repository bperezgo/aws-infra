import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthCi, synthEcr, synthLagunaWeb } from './support/harness';

// laguna's operations UI (Next.js), formerly on Netlify. It runs as its own
// Fargate service behind its own Cloudflare Tunnel and reaches the backend
// server-side, over the VPC. Its own stack so a UI deploy never rolls laguna.

type ContainerDef = {
  Name: string;
  Environment?: Array<{ Name: string; Value: unknown }>;
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
  HealthCheck?: { Command: string[] };
  PortMappings?: Array<{ ContainerPort: number }>;
};

const containers = (template: ReturnType<typeof synthLagunaWeb>['template']) => {
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1, 'expected exactly one task definition');
  return (taskDefs[0] as any).Properties.ContainerDefinitions as ContainerDef[];
};
const container = (template: ReturnType<typeof synthLagunaWeb>['template'], name: string) => {
  const c = containers(template).find((x) => x.Name === name);
  assert.ok(c, `no ${name} container in the task definition`);
  return c;
};
const envOf = (c: ContainerDef): Record<string, unknown> =>
  Object.fromEntries((c.Environment ?? []).map((e) => [e.Name, e.Value]));
const literal = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : JSON.stringify(v).replace(/\{"Fn::ImportValue":"[^"]*"\}/g, '<token>');

describe('LagunaWebStack — laguna-web service', () => {
  const { template } = synthLagunaWeb();

  test('one Fargate Spot service, circuit breaker on', () => {
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
      ]),
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
    });
  });

  test('serves Next on 3000, bound to all interfaces', () => {
    const app = container(template, 'app');
    assert.deepEqual(app.PortMappings, [{ ContainerPort: 3000, Protocol: 'tcp' }]);
    const env = envOf(app);
    assert.equal(literal(env.PORT), '3000');
    // Next standalone binds HOSTNAME; the container hostname would make it
    // listen on the task's own name only and fail the health check.
    assert.equal(literal(env.HOSTNAME), '0.0.0.0');
    assert.equal(literal(env.NODE_ENV), 'production');
  });

  test('reaches the backend over its Cloud Map name, not the internet', () => {
    const url = literal(envOf(container(template, 'app')).NEXT_PUBLIC_API_URL);
    assert.match(url, /^http:\/\/laguna\..+:8080\/api$/);
  });

  test('carries no secret values: the app has no secrets, only the tunnel token', () => {
    assert.deepEqual(container(template, 'app').Secrets ?? [], []);
    assert.deepEqual(
      (container(template, 'cloudflared').Secrets ?? []).map((s) => s.Name),
      ['TUNNEL_TOKEN'],
    );
  });

  test('health check does not depend on the backend being up', () => {
    // /favicon.svg is a static file, so a laguna outage or deploy never fails
    // (and so never rolls back) the UI.
    const cmd = (container(template, 'app').HealthCheck?.Command ?? []).join(' ');
    assert.match(cmd, /127\.0\.0\.1:3000\/favicon\.svg/);
    assert.doesNotMatch(cmd, /\/api\//);
  });

  test('is not registered in Cloud Map: nothing calls it inside the VPC', () => {
    const svc = Object.values(template.findResources('AWS::ECS::Service'))[0] as any;
    assert.equal(svc.Properties.ServiceRegistries, undefined);
  });

  test('laguna admits the web task on 8080, from this stack', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 8080,
      ToPort: 8080,
      SourceSecurityGroupId: Match.anyValue(),
      Description: Match.stringLikeRegexp('laguna-web'),
    });
  });

  test('the task SG takes no inbound traffic', () => {
    const sgs = Object.values(template.findResources('AWS::EC2::SecurityGroup')) as any[];
    for (const sg of sgs) assert.equal(sg.Properties.SecurityGroupIngress, undefined);
  });

  test('webTunnel=off drops cloudflared', () => {
    const { template: t } = synthLagunaWeb({ webTunnel: 'off' });
    assert.ok(!containers(t).some((c) => c.Name === 'cloudflared'));
  });

  test('webDesiredCount=0 parks the service', () => {
    const { template: t } = synthLagunaWeb({ webDesiredCount: 0 });
    t.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
  });
});

describe('EcrStack — laguna-web repo', () => {
  test('laguna-web repo is retained', () => {
    synthEcr().template.hasResource('AWS::ECR::Repository', {
      Properties: Match.objectLike({ RepositoryName: 'laguna-web' }),
      DeletionPolicy: 'Retain',
    });
  });
});

describe('CiStack — laguna release role pushes the web image', () => {
  test('the laguna push role can push to laguna-web', () => {
    const policies = JSON.stringify(synthCi().template.findResources('AWS::IAM::Policy'));
    assert.match(policies, /LagunaWebRepo/);
  });
});
