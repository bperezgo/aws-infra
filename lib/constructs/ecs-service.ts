import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { RemovalPolicy } from 'aws-cdk-lib';

export interface EcsServiceProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  serviceName: string;
  containerImage: string;
  containerPort?: number;
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  useFargateSpot?: boolean;
  environment?: Record<string, string>;
  secrets?: Record<string, ecs.Secret>;
  cloudflareTunnelToken?: string;
  healthCheckPath?: string;
}

export class EcsService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsServiceProps) {
    super(scope, id);

    const {
      vpc,
      cluster,
      namespace,
      serviceName,
      containerImage,
      containerPort = 8080,
      cpu = 256,
      memory = 512,
      desiredCount = 1,
      useFargateSpot = true,
      environment = {},
      secrets = {},
      cloudflareTunnelToken,
      healthCheckPath = '/health',
    } = props;

    const hasTunnel = !!cloudflareTunnelToken;

    // Security group — no inbound needed, CloudFlare Tunnel connects outbound
    this.securityGroup = new ec2.SecurityGroup(this, 'SG', {
      vpc,
      description: `${serviceName} service`,
      allowAllOutbound: true,
    });

    // Log group
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/ecs/${serviceName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Task definition — add extra resources if tunnel sidecar
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: hasTunnel ? cpu + 256 : cpu,
      memoryLimitMiB: hasTunnel ? memory + 256 : memory,
    });

    // Main container
    const container = this.taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(containerImage),
      portMappings: [{ containerPort }],
      environment: {
        SERVICE_NAME: serviceName,
        ...environment,
      },
      secrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'ecs',
      }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${containerPort}${healthCheckPath} || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // CloudFlare Tunnel sidecar
    if (hasTunnel) {
      this.taskDefinition.addContainer('cloudflared', {
        image: ecs.ContainerImage.fromRegistry('cloudflare/cloudflared:latest'),
        command: ['tunnel', '--no-autoupdate', 'run'],
        environment: {
          TUNNEL_TOKEN: cloudflareTunnelToken,
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'cloudflared',
        }),
        essential: true,
      });
    }

    // Service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount,
      assignPublicIp: false,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: [
        {
          capacityProvider: useFargateSpot ? 'FARGATE_SPOT' : 'FARGATE',
          weight: 1,
        },
      ],
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: serviceName,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
      enableExecuteCommand: true,
    });
  }
}
