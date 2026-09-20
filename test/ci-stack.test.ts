import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthCi } from './support/harness';

// The OIDC push roles are the ONLY way images reach ECR (no static keys). These
// tests pin the trust boundary: one shared provider, tag-only trust, and a
// microbiome role scoped to exactly the three microbiome repos. A wrong `sub`
// silently breaks the release job, so it's worth locking down.
describe('CiStack — GitHub OIDC push roles', () => {
  const { template } = synthCi();

  test('creates exactly one GitHub OIDC provider (account-wide singleton)', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  test('laguna push role trusts only release tags on the laguna repo', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'gha-laguna-ecr-push',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub':
                  'repo:bperezgo/laguna-escondida-backend:ref:refs/tags/v*',
              },
            }),
          }),
        ]),
      },
    });
  });

  test('microbiome push role trusts release tags on bperezgo/micobiome-lab (note the slug typo)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'gha-microbiome-ecr-push',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
              // ⚠ EXACT slug incl. the missing second "r" — the app repo's git
              // remote is git@github.com:bperezgo/micobiome-lab.git. Renaming the
              // repo without updating this breaks the release job's role assume.
              StringLike: {
                'token.actions.githubusercontent.com:sub':
                  'repo:bperezgo/micobiome-lab:ref:refs/tags/v*',
              },
            }),
          }),
        ]),
      },
    });
  });

  test('microbiome push policy is scoped to exactly the three microbiome ECR repos', () => {
    // Two push policies exist (laguna → 1 repo, microbiome → 3). The microbiome
    // one is identifiable as the ecr:PutImage statement whose Resource lists three
    // ARNs — least-privilege: this role can push nowhere else.
    const policies = template.findResources('AWS::IAM::Policy');
    const scopedToThree = Object.values(policies).some((p: any) =>
      p.Properties.PolicyDocument.Statement.some(
        (s: any) =>
          Array.isArray(s.Action) &&
          s.Action.includes('ecr:PutImage') &&
          Array.isArray(s.Resource) &&
          s.Resource.length === 3,
      ),
    );
    assert.ok(scopedToThree, 'expected a push policy scoped to 3 ECR repos');
  });
});
