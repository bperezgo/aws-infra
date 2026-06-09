import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';

export interface ServicesStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  /**
   * Stack owning all ECR repos. ServicesStack reads `ecr.laguna`, `ecr.aiAgents`,
   * etc. directly — add a repo to EcrStack and it's available here, no prop wiring.
   * Lifecycle decoupled: destroy services, images survive.
   */
  ecr: EcrStack;
  /**
   * Container image tags, sourced from image-tags.json at repo root.
   * Bump the file and redeploy to roll a service.
   */
  imageTags: {
    laguna: string;
  };
}

export class ServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const {
      vpc,
      cluster,
      namespace,
      database,
      dbSecurityGroup,
      ecr,
      imageTags,
    } = props;

    // Release-driven deploys: image at imageTags.laguna must exist in ECR
    // before `cdk deploy` runs. Override to 0 if you need to scale down:
    //   cdk deploy -c lagunaDesiredCount=0
    const lagunaDesiredCount = Number(
      this.node.tryGetContext('lagunaDesiredCount') ?? 1,
    );

    // Re-import DB SG by ID so ingress rules added below land in this
    // (services) stack, not the data stack. Avoids data <-> services cycle.
    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );

    const dbAddress = database.dbInstanceEndpointAddress;
    const dbPort = database.dbInstanceEndpointPort;

    // Tunnel tokens from context or SSM
    // Pass via: cdk deploy -c cfTunnelLaguna=xxx
    // Or set in cdk.json context
    const cfTunnelLaguna = this.node.tryGetContext('cfTunnelLaguna') || '';

    // --- Laguna Escondida ---
    const laguna = new EcsService(this, 'Laguna', {
      vpc,
      cluster,
      namespace,
      serviceName: 'laguna',
      containerImage: ecs.ContainerImage.fromEcrRepository(ecr.laguna, imageTags.laguna),
      containerPort: 8080,
      cpu: 256,
      memory: 512,
      desiredCount: lagunaDesiredCount,
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

    // Grant laguna DB access — ingress added on imported SG handle
    // so the rule resource lives in this stack.
    dbSgLocal.addIngressRule(
      laguna.securityGroup,
      ec2.Port.tcp(5432),
      `${laguna.node.id} -> postgres`,
    );
  }
}
