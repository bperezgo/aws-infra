import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EcrStack } from './ecr-stack';

export interface CiStackProps extends cdk.StackProps {
  projectName: string;
  ecr: EcrStack;
  /**
   * GitHub org/user that owns the backend repos. Used to scope OIDC trust
   * so only your repos can assume the push roles.
   */
  githubOwner: string;
}

/**
 * GitHub Actions → AWS via OIDC. No long-lived access keys.
 *
 * Each backend repo gets a dedicated push role scoped to its ECR repo and
 * to release tag refs only (`refs/tags/v*`). Merges to main do NOT assume
 * the role — only `release: published` workflows do.
 *
 * NOTE: account can only have ONE OIDC provider for token.actions.githubusercontent.com.
 * If you already have one (from another stack/Terraform), delete the
 * `OpenIdConnectProvider` below and import via:
 *   iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOidc', arn)
 */
export class CiStack extends cdk.Stack {
  public readonly lagunaPushRole: iam.Role;
  public readonly marketingPushRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const { ecr, githubOwner } = props;

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    this.lagunaPushRole = this.makePushRole({
      id: 'LagunaPushRole',
      roleName: 'gha-laguna-ecr-push',
      provider,
      githubOwner,
      githubRepo: 'laguna-escondida-backend',
      repositoryArns: [ecr.laguna.repositoryArn],
    });

    new cdk.CfnOutput(this, 'LagunaPushRoleArn', {
      value: this.lagunaPushRole.roleArn,
      description: 'Paste into laguna-escondida-backend repo as AWS_ROLE_ARN var',
    });

    // marketing-app: one role pushing every release image (agent, migrations,
    // console).
    this.marketingPushRole = this.makePushRole({
      id: 'MarketingPushRole',
      roleName: 'gha-marketing-ecr-push',
      provider,
      githubOwner,
      githubRepo: 'marketing-app',
      // This repo opted into GitHub's immutable OIDC subject, so its tokens
      // carry `repo:<owner>@<ownerId>/<repo>@<repoId>:...`. IDs from
      // `gh api repos/bperezgo/marketing-app/actions/oidc/customization/sub`.
      immutableSubject: { ownerId: '42921391', repoId: '1377597523' },
      repositoryArns: [
        ecr.whatsappAgent.repositoryArn,
        ecr.marketingMigrations.repositoryArn,
        ecr.consoleApi.repositoryArn,
      ],
    });

    new cdk.CfnOutput(this, 'MarketingPushRoleArn', {
      value: this.marketingPushRole.roleArn,
      description: 'Set as AWS_ROLE_ARN repo variable in marketing-app',
    });
  }

  private makePushRole(params: {
    id: string;
    roleName: string;
    provider: iam.IOpenIdConnectProvider;
    githubOwner: string;
    githubRepo: string;
    repositoryArns: string[];
    immutableSubject?: { ownerId: string; repoId: string };
  }): iam.Role {
    const { id, roleName, provider, githubOwner, githubRepo, repositoryArns, immutableSubject } = params;

    const subjectRepo = immutableSubject
      ? `${githubOwner}@${immutableSubject.ownerId}/${githubRepo}@${immutableSubject.repoId}`
      : `${githubOwner}/${githubRepo}`;

    const role = new iam.Role(this, id, {
      roleName,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          // Only tag pushes (releases) can assume — not branches, not PRs.
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${subjectRepo}:ref:refs/tags/v*`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // ECR auth token is account-wide, can't be scoped to a repo.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Push/pull scoped to these repos only. Pull (GetDownloadUrlForLayer) is needed by the
    // release workflow's Trivy scan, which reads the image back from ECR after the push.
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:CompleteLayerUpload',
        'ecr:InitiateLayerUpload',
        'ecr:PutImage',
        'ecr:UploadLayerPart',
      ],
      resources: repositoryArns,
    }));

    return role;
  }
}
