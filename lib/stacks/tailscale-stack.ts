import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface TailscaleStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  tailscaleAuthKeySecretArn: string;
}

/**
 * Tailscale subnet router — a t4g.nano EC2 instance that advertises the VPC
 * CIDR to the Tailscale mesh. Once your Mac joins the same Tailscale account,
 * DBeaver can connect directly to the RDS endpoint with no tunnel command.
 *
 * Requires a one-time step after first deploy:
 *   tailscale.com/admin/machines → Edit route settings → approve the VPC CIDR.
 *
 * See docs/tailscale-db-access.md for the full setup guide.
 */
export class TailscaleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TailscaleStackProps) {
    super(scope, id, props);

    const { projectName, vpc, dbSecurityGroup, tailscaleAuthKeySecretArn } = props;

    const sg = new ec2.SecurityGroup(this, 'SG', {
      vpc,
      description: `${projectName} tailscale subnet router`,
      // Tailscale connects outbound to relay/DERP servers — no inbound rules needed.
      allowAllOutbound: true,
    });

    // Re-import DB SG by ID so the ingress rule resource lives in this stack,
    // not the data stack — same pattern as db-admin-stack to avoid cross-stack cycles.
    const dbSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DbSgImport',
      dbSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );
    dbSgLocal.addIngressRule(sg, ec2.Port.tcp(5432), 'tailscale bastion to postgres');

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // SSM Session Manager — shell access without port 22 or a key pair.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'TailscaleKey',
      tailscaleAuthKeySecretArn,
    ).grantRead(role);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Install Tailscale via official script (adds the tailscale yum repo + installs)
      'curl -fsSL https://tailscale.com/install.sh | sh',
      // Kernel IP forwarding — required for subnet routing
      'echo "net.ipv4.ip_forward = 1" | tee /etc/sysctl.d/99-tailscale.conf',
      'echo "net.ipv6.conf.all.forwarding = 1" | tee -a /etc/sysctl.d/99-tailscale.conf',
      'sysctl -p /etc/sysctl.d/99-tailscale.conf',
      // Fetch region from IMDSv2 (needed for the Secrets Manager CLI call)
      'TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'REGION=$(curl -sH "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      // Fetch auth key and bring Tailscale up as a subnet router
      `AUTH_KEY=$(aws secretsmanager get-secret-value --secret-id "${tailscaleAuthKeySecretArn}" --query SecretString --output text --region "$REGION")`,
      `tailscale up --authkey="$AUTH_KEY" --advertise-routes="${vpc.vpcCidrBlock}" --accept-dns=false`,
    );

    const instance = new ec2.Instance(this, 'Instance', {
      instanceName: `${projectName}-tailscale-bastion`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true,
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'Use to shell in: aws ssm start-session --target <id>',
    });
  }
}
