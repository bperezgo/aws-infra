import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/stacks/network-stack';
import { DataStack } from '../../lib/stacks/data-stack';
import { EcrStack } from '../../lib/stacks/ecr-stack';
import { ServicesStack } from '../../lib/stacks/services-stack';

// Fixed, valid-looking values so tests are deterministic and never hit AWS.
// projectName must satisfy lib/config/schema.ts (lowercase, letter-first, 3-31).
export const TEST_PROJECT = 'bryan-test';
const TEST_ENV: cdk.Environment = { account: '123456789012', region: 'us-east-1' };

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

export function synthServices(): { stack: ServicesStack; template: Template } {
  const app = new cdk.App();
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
    imageTags: { laguna: 'v1.1.9', cloudflared: '2026.7.1' },
  });
  return { stack, template: Template.fromStack(stack) };
}
