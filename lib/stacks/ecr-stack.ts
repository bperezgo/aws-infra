import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  projectName: string;
}

export class EcrStack extends cdk.Stack {
  public readonly laguna: ecr.Repository;
  public readonly whatsappAgent: ecr.Repository;
  public readonly marketingMigrations: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    // RETAIN — destroying services-stack must never wipe image registry.
    // emptyOnDelete:false guards against accidental `cdk destroy` deleting tags.
    this.laguna = new ecr.Repository(this, 'LagunaRepo', {
      repositoryName: 'laguna-escondida',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // marketing-app publishes two images per release: the service, and its SQL
    // migrations baked onto the migrate CLI (run as a one-off task before the
    // service rolls — see DbAdminStack).
    this.whatsappAgent = new ecr.Repository(this, 'WhatsappAgentRepo', {
      repositoryName: 'whatsapp-agent',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });
    this.marketingMigrations = new ecr.Repository(this, 'MarketingMigrationsRepo', {
      repositoryName: 'marketing-migrations',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    new cdk.CfnOutput(this, 'LagunaRepoUri', {
      value: this.laguna.repositoryUri,
      description: 'docker tag / push target for laguna backend',
    });
  }
}
