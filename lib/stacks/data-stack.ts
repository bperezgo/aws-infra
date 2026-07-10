import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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
        // PG18 to match the DigitalOcean source (also 18) and local tooling
        // (pg_dump 18.4). This removes the cross-version dump/restore breakage:
        // a v16 server rejected the v18 dump's archive header AND its
        // `transaction_timeout` GUC. 16.13 -> 18.4 is a valid *direct* RDS major
        // upgrade, applied in place — the laguna_escondida DB, laguna_app role, and
        // applied migrations are preserved. `.of()` pins 18.4 regardless of the
        // aws-cdk-lib enum (which only ships up to VER_18_3 in this version).
        version: rds.PostgresEngineVersion.of('18.4', '18'),
      }),
      // Required for RDS to run a MAJOR-version upgrade on an existing instance;
      // without it the modify is rejected. NB Postgres major upgrades are one-way
      // (no in-place downgrade) — RDS auto-takes a pre-upgrade snapshot as a fallback.
      allowMajorVersionUpgrade: true,
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
      bucketName: `${projectName}-laguna-assets`,
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

    // Outputs
    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'CdnDomain', {
      value: this.cdnDomain,
    });
  }
}
