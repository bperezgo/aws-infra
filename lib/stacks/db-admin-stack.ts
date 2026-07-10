import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DbAdminStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  database: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
}

/**
 * On-demand database admin task — the DELIBERATE, decoupled way to run
 * *data-plane* operations (create databases/roles, import a dump) against the
 * private RDS instance from **inside** the VPC. RDS lives in isolated subnets and
 * is unreachable from a laptop by design, so admin SQL runs from a short-lived
 * Fargate task here.
 *
 * Nothing runs on `cdk deploy` — this stack only DEFINES a runnable task. You
 * trigger it with `scripts/db/run-sql.sh`, which overrides the container command
 * with the SQL to execute. Keeping data-plane work out of the deploy is
 * intentional: a stack destroy/replace must never be able to drop a real
 * database. (See docs/networking-decisions.md sibling note + the runbook.)
 */
export class DbAdminStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DbAdminStackProps) {
    super(scope, id, props);

    const { projectName, vpc, cluster, database, dbSecurityGroup } = props;

    // SG for the admin task. Needs egress to pull the postgres image and to reach
    // RDS:5432; no inbound. Runs in a public subnet (Mode A) like the app tasks.
    const adminSg = new ec2.SecurityGroup(this, 'DbAdminSG', {
      vpc,
      description: `${projectName} db-admin one-off task`,
      allowAllOutbound: true,
    });

    // Let the admin task reach RDS. Re-import the DB SG by id so this ingress rule
    // resource lives in THIS stack (not the data stack) — avoids a cross-stack
    // cycle, same pattern services-stack uses for the app task.
    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );
    dbSgLocal.addIngressRule(
      adminSg,
      ec2.Port.tcp(5432),
      'db-admin task to postgres',
    );

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/ecs/${projectName}-dbadmin`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDef.addContainer('dbadmin', {
      // AWS's public mirror of the official postgres image — ships psql, and avoids
      // Docker Hub auth/rate limits.
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/docker/library/postgres:16-alpine',
      ),
      // Standard libpq env so `psql` needs no connection flags. Connect to the
      // default 'postgres' maintenance DB — CREATE DATABASE can't run from inside
      // the database being created. Creds come from the RDS master secret (this
      // grants the execution role read on that secret automatically).
      environment: {
        PGHOST: database.dbInstanceEndpointAddress,
        PGPORT: database.dbInstanceEndpointPort,
        PGDATABASE: 'postgres',
        PGSSLMODE: 'require',
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        // Injected so create-laguna-role.sql can set the laguna_app role's password
        // straight from the secret — the value never lands in a file, the CLI, or
        // CloudTrail. NB: this lets the admin task read the app secret (IAM is
        // per-secret); acceptable since the admin task is already privileged.
        LAGUNA_DB_PASSWORD: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretNameV2(
            this,
            'LagunaAppSecret',
            `${projectName}/laguna/app`,
          ),
          'DB_PASSWORD',
        ),
      },
      // Harmless default (a connectivity check); run-sql.sh overrides this.
      command: ['psql', '-c', 'SELECT 1'],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'dbadmin' }),
    });

    // Consumed by scripts/db/run-sql.sh to launch the one-off task.
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'TaskDefArn', { value: taskDef.taskDefinitionArn });
    new cdk.CfnOutput(this, 'AdminSecurityGroupId', {
      value: adminSg.securityGroupId,
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}
