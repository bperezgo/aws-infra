import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  projectName: string;
}

export class EcrStack extends cdk.Stack {
  public readonly laguna: ecr.Repository;
  public readonly microbiomeApi: ecr.Repository;
  public readonly microbiomeWorker: ecr.Repository;
  public readonly microbiomeUi: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    // RETAIN — destroying services-stack must never wipe image registry.
    // emptyOnDelete:false guards against accidental `cdk destroy` deleting tags.
    const mk = (id: string, name: string) =>
      new ecr.Repository(this, id, {
        repositoryName: name,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        emptyOnDelete: false,
        imageScanOnPush: true,
        lifecycleRules: [{ maxImageCount: 10 }],
      });

    this.laguna = mk('LagunaRepo', 'laguna-escondida');

    // microbiome-lab: three images (api + worker + ui) built from one repo.
    this.microbiomeApi = mk('MicrobiomeApiRepo', 'microbiome-lab-api');
    this.microbiomeWorker = mk('MicrobiomeWorkerRepo', 'microbiome-lab-worker');
    this.microbiomeUi = mk('MicrobiomeUiRepo', 'microbiome-lab-ui');

    new cdk.CfnOutput(this, 'LagunaRepoUri', {
      value: this.laguna.repositoryUri,
      description: 'docker tag / push target for laguna backend',
    });
    new cdk.CfnOutput(this, 'MicrobiomeApiRepoUri', {
      value: this.microbiomeApi.repositoryUri,
      description: 'docker tag / push target for microbiome-lab api',
    });
    new cdk.CfnOutput(this, 'MicrobiomeWorkerRepoUri', {
      value: this.microbiomeWorker.repositoryUri,
      description: 'docker tag / push target for microbiome-lab worker',
    });
    new cdk.CfnOutput(this, 'MicrobiomeUiRepoUri', {
      value: this.microbiomeUi.repositoryUri,
      description: 'docker tag / push target for microbiome-lab ui',
    });
  }
}
