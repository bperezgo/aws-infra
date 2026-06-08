import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  projectName: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { projectName } = props;

    // 2 AZs required for RDS DB subnet group (AWS hard rule).
    // No NAT Gateway — use VPC endpoints instead ($0 vs $64/month).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${projectName}-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'data',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Interface endpoints pinned to single AZ to halve ENI cost (~$28/mo
    // saved vs deploying in both AZs). Cross-AZ traffic to endpoint ~$0.01/GB,
    // acceptable at dev scale. Bump to both AZs if HA matters.
    const endpointSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      availabilityZones: [this.vpc.availabilityZones[0]],
    };

    // VPC Endpoints — avoid NAT Gateway, services still reach AWS APIs
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: endpointSubnets,
    });

    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: endpointSubnets,
    });

    this.vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: endpointSubnets,
    });

    this.vpc.addInterfaceEndpoint('SecretsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: endpointSubnets,
    });

    // ECS Cluster — Fargate Spot default
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${projectName}-cluster`,
      vpc: this.vpc,
      containerInsights: false, // Enable later if needed
      enableFargateCapacityProviders: true,
    });

    // Service discovery namespace
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: `${projectName}.local`,
      vpc: this.vpc,
    });
  }
}
