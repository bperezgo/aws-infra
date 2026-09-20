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
  public readonly microbiomePushRole: iam.Role;

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

    // microbiome-lab: ONE role, scoped to the three microbiome ECR repos, that the
    // repo's release.yml assumes to push api/worker/ui in one matrix build.
    // ⚠ githubRepo is the EXACT slug incl. the typo (missing 2nd "r"): the app repo
    // remote is git@github.com:bperezgo/micobiome-lab.git. The trust `sub` becomes
    // `repo:bperezgo/micobiome-lab:ref:refs/tags/v*` — rename the GitHub repo and
    // this stops trusting it; update githubRepo in the same commit if you do.
    this.microbiomePushRole = this.makePushRole({
      id: 'MicrobiomePushRole',
      roleName: 'gha-microbiome-ecr-push',
      provider,
      githubOwner,
      githubRepo: 'micobiome-lab',
      repositoryArns: [
        ecr.microbiomeApi.repositoryArn,
        ecr.microbiomeWorker.repositoryArn,
        ecr.microbiomeUi.repositoryArn,
      ],
    });

    new cdk.CfnOutput(this, 'MicrobiomePushRoleArn', {
      value: this.microbiomePushRole.roleArn,
      description: 'Set as AWS_ROLE_ARN repo variable in bperezgo/micobiome-lab',
    });
  }

  private makePushRole(params: {
    id: string;
    roleName: string;
    provider: iam.IOpenIdConnectProvider;
    githubOwner: string;
    githubRepo: string;
    repositoryArns: string[];
  }): iam.Role {
    const { id, roleName, provider, githubOwner, githubRepo, repositoryArns } = params;

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
            'token.actions.githubusercontent.com:sub': `repo:${githubOwner}/${githubRepo}:ref:refs/tags/v*`,
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

    // Push/pull scoped to these repos only.
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
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
