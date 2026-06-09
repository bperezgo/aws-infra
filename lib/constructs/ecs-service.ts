import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { RemovalPolicy } from 'aws-cdk-lib';

export interface EfsVolumeMount {
  fileSystem: efs.IFileSystem;
  accessPoint: efs.IAccessPoint;
  containerPath: string;
  volumeName?: string;
  readOnly?: boolean;
}

export interface EcsServiceProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  serviceName: string;
  containerImage: ecs.ContainerImage;
  containerPort?: number;
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  useFargateSpot?: boolean;
  environment?: Record<string, string>;
  secrets?: Record<string, ecs.Secret>;
  cloudflareTunnelToken?: string;
  cloudflareTunnelTokenSecret?: ecs.Secret;
  healthCheckPath?: string;
  efsVolumes?: EfsVolumeMount[];
  /**
   * Phase A (default): task runs in PUBLIC subnet with public IP for outbound
   * to Docker Hub / CF edge / 3rd-party APIs. Inbound still closed by SG.
   * Set false once NAT (or full VPC endpoint coverage) is in place.
   */
  publicNetworking?: boolean;
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
      cloudflareTunnelTokenSecret,
      healthCheckPath = '/health',
      efsVolumes = [],
      publicNetworking = true,
    } = props;

    const hasTunnel = !!(cloudflareTunnelToken || cloudflareTunnelTokenSecret);

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

    // EFS volumes — register on task def, build mount points for app container
    const appMountPoints: ecs.MountPoint[] = efsVolumes.map((v, i) => {
      const volumeName = v.volumeName ?? `efs-${i}`;
      this.taskDefinition.addVolume({
        name: volumeName,
        efsVolumeConfiguration: {
          fileSystemId: v.fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: v.accessPoint.accessPointId,
            iam: 'ENABLED',
          },
        },
      });
      return {
        sourceVolume: volumeName,
        containerPath: v.containerPath,
        readOnly: v.readOnly ?? false,
      };
    });

    // Main container
    const container = this.taskDefinition.addContainer('app', {
      image: containerImage,
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

    if (appMountPoints.length > 0) {
      container.addMountPoints(...appMountPoints);
    }

    // Grant task role EFS client access + allow NFS from service SG.
    // Ingress is added via SG ID re-import so the rule resource lives in
    // *this* stack (services), not the EFS owner (data) — avoids cycle.
    efsVolumes.forEach((v, i) => {
      v.fileSystem.grantRootAccess(this.taskDefinition.taskRole);
      v.fileSystem.connections.securityGroups.forEach((sg, j) => {
        const local = ec2.SecurityGroup.fromSecurityGroupId(
          this,
          `EfsSgImport-${i}-${j}`,
          sg.securityGroupId,
          { mutable: true },
        );
        local.addIngressRule(
          this.securityGroup,
          ec2.Port.tcp(2049),
          `${serviceName} NFS`,
        );
      });
    });

    // CloudFlare Tunnel sidecar — prefer Secrets Manager over plaintext context
    if (hasTunnel) {
      this.taskDefinition.addContainer('cloudflared', {
        image: ecs.ContainerImage.fromRegistry('cloudflare/cloudflared:latest'),
        command: ['tunnel', '--no-autoupdate', 'run'],
        environment: cloudflareTunnelTokenSecret
          ? undefined
          : { TUNNEL_TOKEN: cloudflareTunnelToken! },
        secrets: cloudflareTunnelTokenSecret
          ? { TUNNEL_TOKEN: cloudflareTunnelTokenSecret }
          : undefined,
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
      assignPublicIp: publicNetworking,
      securityGroups: [this.securityGroup],
      vpcSubnets: {
        subnetType: publicNetworking
          ? ec2.SubnetType.PUBLIC
          : ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
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
