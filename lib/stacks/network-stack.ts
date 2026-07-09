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

    // S3 gateway endpoint — FREE (gateway endpoints cost $0), so keep it.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // No interface (PrivateLink) endpoints — intentionally. Tasks run in public
    // subnets with a public IP, so they already reach ECR / CloudWatch Logs /
    // Secrets Manager free through the internet gateway; endpoints would only add
    // ~$29/mo of idle ENIs. The private-subnet upgrade path (Mode B) uses a NAT,
    // which also doesn't need endpoints — and endpoints-without-NAT (Mode C) is
    // ruled out because cloudflared pulls from Docker Hub, which they can't reach.
    // Full rationale: docs/networking-decisions.md.

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
