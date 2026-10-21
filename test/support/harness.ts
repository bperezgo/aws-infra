import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/stacks/network-stack';
import { DataStack } from '../../lib/stacks/data-stack';
import { EcrStack } from '../../lib/stacks/ecr-stack';
import { ServicesStack } from '../../lib/stacks/services-stack';
import { MarketingStack } from '../../lib/stacks/marketing-stack';
import { DbAdminStack } from '../../lib/stacks/db-admin-stack';
import { CiStack } from '../../lib/stacks/ci-stack';

// Fixed, valid-looking values so tests are deterministic and never hit AWS.
// projectName must satisfy lib/config/schema.ts (lowercase, letter-first, 3-31).
export const TEST_PROJECT = 'bryan-test';
const TEST_ENV: cdk.Environment = { account: '123456789012', region: 'us-east-1' };
export const TEST_IMAGE_TAGS = {
  laguna: 'v1.1.9',
  whatsappAgent: 'v0.1.0',
  cloudflared: '2026.7.1',
  alloy: 'v1.18.1',
};

/**
 * Synth helpers return the CloudFormation Template for a stack so tests can
 * assert on the *synthesized* infra without deploying. This is the fast rung of
 * the harness: seconds, deterministic, zero AWS calls, zero cost.
 *
 * Each helper builds its own cdk.App so tests stay isolated.
 */
export function synthNetwork(): { stack: NetworkStack; template: Template } {
  const app = new cdk.App();
  const stack = new NetworkStack(app, `${TEST_PROJECT}-network`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  return { stack, template: Template.fromStack(stack) };
}

export function synthData(): { stack: DataStack; template: Template } {
  const app = new cdk.App();
  // DataStack needs a VPC; reuse the real NetworkStack so the test also proves
  // the two compose. Cross-stack refs become Fn::ImportValue at synth — fine.
  const network = new NetworkStack(app, `${TEST_PROJECT}-network`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  const stack = new DataStack(app, `${TEST_PROJECT}-data`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
  });
  return { stack, template: Template.fromStack(stack) };
}

/**
 * `context` mirrors `cdk deploy -c key=value`, so tests can exercise the
 * documented escape hatches (e.g. `{ lagunaAlloy: 'off' }`) instead of only the
 * happy path. Defaults to none, so existing callers are unchanged.
 */
export function synthServices(
  context: Record<string, unknown> = {},
): { stack: ServicesStack; template: Template } {
  const app = new cdk.App({ context });
  // Wire the full dependency graph exactly like bin/app.ts does. Secrets are
  // imported by name (fromSecretNameV2) so nothing here needs AWS access.
  const network = new NetworkStack(app, `${TEST_PROJECT}-network`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  const data = new DataStack(app, `${TEST_PROJECT}-data`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
  });
  const ecr = new EcrStack(app, `${TEST_PROJECT}-ecr`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  const stack = new ServicesStack(app, `${TEST_PROJECT}-services`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
    cluster: network.cluster,
    namespace: network.namespace,
    database: data.database,
    dbSecurityGroup: data.dbSecurityGroup,
    ecr,
    assetsBucket: data.assetsBucket,
    imageTags: TEST_IMAGE_TAGS,
  });
  return { stack, template: Template.fromStack(stack) };
}

/** Network + data + ECR, wired like bin/app.ts, for the stacks that consume them. */
function foundation(app: cdk.App) {
  const network = new NetworkStack(app, `${TEST_PROJECT}-network`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  const data = new DataStack(app, `${TEST_PROJECT}-data`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
  });
  const ecr = new EcrStack(app, `${TEST_PROJECT}-ecr`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  return { network, data, ecr };
}

export function synthMarketing(
  context: Record<string, unknown> = {},
): { stack: MarketingStack; template: Template } {
  const app = new cdk.App({ context });
  const { network, data, ecr } = foundation(app);
  const services = new ServicesStack(app, `${TEST_PROJECT}-services`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
    cluster: network.cluster,
    namespace: network.namespace,
    database: data.database,
    dbSecurityGroup: data.dbSecurityGroup,
    ecr,
    assetsBucket: data.assetsBucket,
    imageTags: TEST_IMAGE_TAGS,
  });
  const stack = new MarketingStack(app, `${TEST_PROJECT}-marketing`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
    cluster: network.cluster,
    namespace: network.namespace,
    database: data.database,
    dbSecurityGroup: data.dbSecurityGroup,
    lagunaSecurityGroup: services.lagunaSecurityGroup,
    ecr,
    imageTags: TEST_IMAGE_TAGS,
  });
  return { stack, template: Template.fromStack(stack) };
}

export function synthDbAdmin(): { stack: DbAdminStack; template: Template } {
  const app = new cdk.App();
  const { network, data, ecr } = foundation(app);
  const stack = new DbAdminStack(app, `${TEST_PROJECT}-dbadmin`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    vpc: network.vpc,
    cluster: network.cluster,
    database: data.database,
    dbSecurityGroup: data.dbSecurityGroup,
    ecr,
    imageTags: TEST_IMAGE_TAGS,
  });
  return { stack, template: Template.fromStack(stack) };
}

export function synthEcr(): { stack: EcrStack; template: Template } {
  const app = new cdk.App();
  const stack = new EcrStack(app, `${TEST_PROJECT}-ecr`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  return { stack, template: Template.fromStack(stack) };
}

export function synthCi(): { stack: CiStack; template: Template } {
  const app = new cdk.App();
  const ecr = new EcrStack(app, `${TEST_PROJECT}-ecr`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
  });
  const stack = new CiStack(app, `${TEST_PROJECT}-ci`, {
    env: TEST_ENV,
    projectName: TEST_PROJECT,
    ecr,
    githubOwner: 'test-owner',
  });
  return { stack, template: Template.fromStack(stack) };
}
