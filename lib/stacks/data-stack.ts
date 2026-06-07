import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly assetsBucket: s3.Bucket;
  public readonly cdnDomain: string;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly n8nFileSystem: efs.FileSystem;
  public readonly n8nAccessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { projectName, vpc } = props;

    // --- RDS PostgreSQL ---
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: false,
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: `${projectName}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO, // Free tier
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      databaseName: 'main',
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin', {
        secretName: `${projectName}/rds/master`,
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      multiAz: false,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // --- S3 + CloudFront ---
    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `${projectName}-assets`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const cdn = new cloudfront.Distribution(this, 'CDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Cheapest — US/EU
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // SPA support
        },
      ],
    });

    this.cdnDomain = cdn.distributionDomainName;

    // --- EFS for n8n state (~/.n8n) ---
    // Encrypted, bursting, lifecycle to IA after 30d. Mount targets created
    // by CDK in the same subnets the FS is attached to (data subnets here).
    this.n8nFileSystem = new efs.FileSystem(this, 'N8nEfs', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // n8n container runs as uid 1000 (node user). Access point chroots there
    // and forces ownership so the container can read/write without root.
    this.n8nAccessPoint = this.n8nFileSystem.addAccessPoint('N8nAp', {
      path: '/n8n',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '750',
      },
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'CdnDomain', {
      value: this.cdnDomain,
    });

    new cdk.CfnOutput(this, 'N8nEfsId', {
      value: this.n8nFileSystem.fileSystemId,
    });
  }
}
