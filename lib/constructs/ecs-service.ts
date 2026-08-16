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
  /**
   * Image for the cloudflared tunnel sidecar. Pass a pinned tag from
   * image-tags.json to avoid `latest` silently re-pulling a new version on
   * every task placement. Defaults to `latest` only for backward compat.
   */
  cloudflaredImage: ecs.ContainerImage;
  /**
   * Grafana Alloy telemetry sidecar. When both `alloyImage` and `alloyConfig`
   * are set, a NON-ESSENTIAL Alloy container is added: it receives OTLP
   * logs+traces from the app on 127.0.0.1:4317/4318 and scrapes the app's
   * Prometheus /metrics, forwarding all three to Grafana Cloud. Non-essential
   * so a telemetry outage (crash/OOM) never takes the app — and the service —
   * down. `alloyConfig` is the HCL config content; it's written to a file by the
   * container entrypoint at boot (Fargate has no ConfigMap-style file mount).
   * `alloySecrets` inject Grafana Cloud creds the config reads via sys.env().
   */
  alloyImage?: ecs.ContainerImage;
  alloyConfig?: string;
  alloySecrets?: Record<string, ecs.Secret>;
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
      cloudflaredImage,
      alloyImage,
      alloyConfig,
      alloySecrets = {},
      healthCheckPath = '/health',
      efsVolumes = [],
      publicNetworking = true,
    } = props;

    const hasTunnel = !!(cloudflareTunnelToken || cloudflareTunnelTokenSecret);
    const hasAlloy = !!(alloyImage && alloyConfig);

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

    // Task definition. Fargate only accepts specific CPU/memory PAIRS (e.g. 0.25
    // vCPU allows 512/1024/2048 MB; 0.5 vCPU needs >=1024) — an arbitrary bump
    // like +256 MB (-> 768) is rejected at deploy. The sidecars (cloudflared,
    // alloy) are lightweight, so when either is present we keep CPU at the app's
    // tier and step memory up to the next valid value (512 -> 1024) to give the
    // containers headroom. Alloy is additionally hard-capped below so it can't
    // starve the app; at 1-3 restaurants app + both sidecars fit in 1024. If
    // Alloy OOMs under real load, bump memory (256 CPU also allows 2048).
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu,
      memoryLimitMiB: hasTunnel || hasAlloy ? memory * 2 : memory,
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
        // Use wget, not curl: the alpine-based service images ship busybox wget
        // but not curl. --spider makes a request without downloading the body and
        // exits non-zero on any non-2xx, which is exactly what ECS wants.
        command: ['CMD-SHELL', `wget --no-verbose --tries=1 --spider http://localhost:${containerPort}${healthCheckPath} || exit 1`],
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
        image: cloudflaredImage,
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

    // Grafana Alloy telemetry sidecar — NON-essential so a telemetry outage never
    // takes the app down. Fargate has no ConfigMap-style file mount, so the config
    // (a non-secret HCL string from the repo) is passed as an env var and written
    // to a file by a tiny shell entrypoint before `alloy run`. Grafana Cloud creds
    // stay in Secrets Manager and are read by the config via sys.env(). Hard memory
    // cap keeps Alloy from starving the app if it balloons under load.
    if (hasAlloy) {
      this.taskDefinition.addContainer('alloy', {
        image: alloyImage,
        essential: false,
        memoryLimitMiB: 256,
        entryPoint: ['/bin/sh', '-c'],
        command: [
          "printf '%s' \"$ALLOY_CONFIG\" > /tmp/config.alloy && " +
            'exec alloy run /tmp/config.alloy --storage.path=/tmp/alloy-data',
        ],
        environment: { ALLOY_CONFIG: alloyConfig },
        secrets: alloySecrets,
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: 'alloy',
        }),
      });
    }

    // Service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount,
      // Fail fast: if a new deployment can't reach a steady state (task keeps
      // crashing or failing its health check), give up in minutes and roll the
      // service back — instead of ECS silently retrying for ~3 hours before
      // CloudFormation reports NotStabilized. Makes bad boots obvious quickly.
      circuitBreaker: { rollback: true },
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
