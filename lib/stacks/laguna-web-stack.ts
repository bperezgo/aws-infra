import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EcsService } from '../constructs/ecs-service';
import { EcrStack } from './ecr-stack';

export interface LagunaWebStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  /** laguna's task SG: the UI calls its API on 8080. */
  lagunaSecurityGroup: ec2.ISecurityGroup;
  ecr: EcrStack;
  imageTags: {
    lagunaWeb: string;
    cloudflared: string;
  };
}

/**
 * laguna's operations UI (laguna-escondida-backend/frontend, Next.js standalone),
 * reached through its own Cloudflare Tunnel. It replaced the Netlify site.
 *
 * A stack of its own, apart from ServicesStack, so a UI deploy never rolls the
 * backend (and the reverse). The browser only talks to this service: every
 * backend call is made by the Next server (route handlers under app/api), so the
 * backend is reached inside the VPC by its Cloud Map name and never needs a
 * public hostname for the UI. The task SG takes no inbound traffic.
 *
 * Release tag: the same `v*` tag as laguna (one tag ships both), but its own key
 * in image-tags.json. Deploy laguna first when a release changes the API.
 */
export class LagunaWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LagunaWebStackProps) {
    super(scope, id, props);

    const { projectName, vpc, cluster, namespace, lagunaSecurityGroup, ecr, imageTags } = props;

    const ctx = (key: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined ? undefined : String(v);
    };
    const desiredCount = Number(ctx('webDesiredCount') ?? 1);
    const tunnelEnabled = ctx('webTunnel') !== 'off';
    const port = 3000;
    const lagunaPort = 8080;

    // What the tunnel sidecar reads: CF_TUNNEL_TOKEN. Its own tunnel and secret,
    // so no other task can read it. Create once, out of band:
    //   aws secretsmanager create-secret --name <projectName>/laguna-web/infra \
    //     --secret-string '{"CF_TUNNEL_TOKEN":"…"}'
    // The app itself has no secrets: sessions are the backend's JWT in a cookie.
    const infraSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LagunaWebInfraSecret',
      `${projectName}/laguna-web/infra`,
    );

    const web = new EcsService(this, 'LagunaWeb', {
      vpc,
      cluster,
      namespace,
      serviceName: 'laguna-web',
      containerImage: ecs.ContainerImage.fromEcrRepository(ecr.lagunaWeb, imageTags.lagunaWeb),
      containerPort: port,
      cpu: 256,
      memory: 512,
      desiredCount,
      cloudflareTunnelTokenSecret: tunnelEnabled
        ? ecs.Secret.fromSecretsManager(infraSecret, 'CF_TUNNEL_TOKEN')
        : undefined,
      cloudflaredImage: ecs.ContainerImage.fromRegistry(
        `cloudflare/cloudflared:${imageTags.cloudflared}`,
      ),
      // A static file, not an /api route: the check must pass while laguna is
      // down or mid-deploy, or the circuit breaker would roll the UI back.
      // 127.0.0.1, not localhost: busybox wget may try ::1 first, and Next listens
      // on IPv4 only. Exec form (no shell) with the node image's own wget.
      healthCheckCommand: ['wget', '--no-verbose', '--tries=1', '--spider', `http://127.0.0.1:${port}/favicon.svg`],
      // Reached only through the tunnel; nothing resolves it inside the VPC.
      cloudMap: false,
      environment: {
        NODE_ENV: 'production',
        PORT: String(port),
        // Next standalone binds HOSTNAME; unset it takes the container's own
        // hostname and listens on that interface only.
        HOSTNAME: '0.0.0.0',
        // Read at runtime by the Next server only (never inlined for the browser).
        NEXT_PUBLIC_API_URL: `http://laguna.${namespace.namespaceName}:${lagunaPort}/api`,
      },
    });

    // Re-imported so the rule lands in this (consuming) stack, like laguna's other
    // consumers: a rule on laguna's own SG object would make a stack cycle.
    const lagunaSgLocal = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'LagunaSgImport',
      lagunaSecurityGroup.securityGroupId,
      { allowAllOutbound: false, mutable: true },
    );
    lagunaSgLocal.addIngressRule(
      web.securityGroup,
      ec2.Port.tcp(lagunaPort),
      'laguna-web to laguna API',
    );
  }
}
