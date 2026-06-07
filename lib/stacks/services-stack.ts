import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';

export interface ServicesStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  assetsBucket: s3.IBucket;
  cdnDomain: string;
}

export class ServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const {
      projectName,
      vpc,
      cluster,
      namespace,
      database,
      assetsBucket,
      cdnDomain,
    } = props;

    const dbAddress = database.dbInstanceEndpointAddress;
    const dbPort = database.dbInstanceEndpointPort;

    // Tunnel tokens from context or SSM
    // Pass via: cdk deploy -c cfTunnelAiAgents=xxx -c cfTunnelLaguna=xxx ...
    // Or set in cdk.json context
    const cfTunnelAiAgents = this.node.tryGetContext('cfTunnelAiAgents') || '';
    const cfTunnelLaguna = this.node.tryGetContext('cfTunnelLaguna') || '';
    const cfTunnelLivingUterus = this.node.tryGetContext('cfTunnelLivingUterus') || '';

    // --- AI Agents Service ---
    const aiAgents = new EcsService(this, 'AiAgents', {
      vpc,
      cluster,
      namespace,
      serviceName: 'ai-agents',
      containerImage: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/ai-agents:latest`,
      containerPort: 8080,
      cpu: 512,
      memory: 1024,
      desiredCount: 1,
      cloudflareTunnelToken: cfTunnelAiAgents,
      environment: {
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        DB_NAME: 'ai_agents',
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // --- Laguna Escondida ---
    const laguna = new EcsService(this, 'Laguna', {
      vpc,
      cluster,
      namespace,
      serviceName: 'laguna',
      containerImage: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/laguna-escondida:latest`,
      containerPort: 8080,
      cpu: 256,
      memory: 512,
      desiredCount: 1,
      cloudflareTunnelToken: cfTunnelLaguna,
      environment: {
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        DB_NAME: 'laguna',
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // --- Living Uterus ---
    const livingUterus = new EcsService(this, 'LivingUterus', {
      vpc,
      cluster,
      namespace,
      serviceName: 'living-uterus',
      containerImage: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/living-uterus:latest`,
      containerPort: 8080,
      cpu: 512,
      memory: 1024,
      desiredCount: 1,
      cloudflareTunnelToken: cfTunnelLivingUterus,
      environment: {
        DB_HOST: dbAddress,
        DB_PORT: dbPort,
        DB_NAME: 'living_uterus',
        ASSETS_BUCKET: assetsBucket.bucketName,
        CDN_DOMAIN: cdnDomain,
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // Grant living-uterus S3 access for video uploads
    assetsBucket.grantReadWrite(livingUterus.taskDefinition.taskRole, 'living-uterus/*');

    // Grant all services DB access
    [aiAgents, laguna, livingUterus].forEach((svc) => {
      database.connections.allowFrom(svc.securityGroup, ec2.Port.tcp(5432));
    });
  }
}
