import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  projectName: string;
}

export class EcrStack extends cdk.Stack {
  public readonly laguna: ecr.Repository;

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

    new cdk.CfnOutput(this, 'LagunaRepoUri', {
      value: this.laguna.repositoryUri,
      description: 'docker tag / push target for laguna backend',
    });
  }
}
