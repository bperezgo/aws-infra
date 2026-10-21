#!/usr/bin/env node
import 'source-map-support/register';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { loadAppConfig, loadImageTags } from '../lib/config';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { CiStack } from '../lib/stacks/ci-stack';
import { ServicesStack } from '../lib/stacks/services-stack';
import { DbAdminStack } from '../lib/stacks/db-admin-stack';
import { MarketingStack } from '../lib/stacks/marketing-stack';
import { TailscaleStack } from '../lib/stacks/tailscale-stack';
import { CostStack } from '../lib/stacks/cost-stack';
import { Guardrails } from '../lib/aspects/guardrails';

const app = new cdk.App();

// Enforcement layer — turns the rules documented in the stack comments into
// synth-time errors (RETAIN on stateful stores, no NAT, private+encrypted S3/RDS).
// A violation fails `cdk synth`, which fails the pre-commit hook and CI.
cdk.Aspects.of(app).add(new Guardrails());

// Fail fast — every required value must be set. No silent defaults.
const cfg = loadAppConfig(app);
const imageTags = loadImageTags(path.join(__dirname, '..'));

const env: cdk.Environment = { account: cfg.account, region: cfg.region };

cdk.Tags.of(app).add('Project', cfg.projectName);
cdk.Tags.of(app).add('Environment', cfg.environment);
cdk.Tags.of(app).add('ManagedBy', 'cdk');

const network = new NetworkStack(app, `${cfg.projectName}-network`, {
  env,
  projectName: cfg.projectName,
});
cdk.Tags.of(network).add('Service', 'network');

const data = new DataStack(app, `${cfg.projectName}-data`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
});
cdk.Tags.of(data).add('Service', 'data');

const ecr = new EcrStack(app, `${cfg.projectName}-ecr`, {
  env,
  projectName: cfg.projectName,
});
cdk.Tags.of(ecr).add('Service', 'ecr');

const ci = new CiStack(app, `${cfg.projectName}-ci`, {
  env,
  projectName: cfg.projectName,
  ecr,
  githubOwner: cfg.githubOwner,
});
cdk.Tags.of(ci).add('Service', 'ci');

const services = new ServicesStack(app, `${cfg.projectName}-services`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  namespace: network.namespace,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
  ecr,
  assetsBucket: data.assetsBucket,
  imageTags,
});
cdk.Tags.of(services).add('Service', 'services');

// marketing-app (WhatsApp agent). Own stack so its deploys never touch laguna.
// Run its migrations (scripts/db/migrate-marketing.sh) before deploying a new tag.
const marketing = new MarketingStack(app, `${cfg.projectName}-marketing`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  namespace: network.namespace,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
  lagunaSecurityGroup: services.lagunaSecurityGroup,
  ecr,
  imageTags,
});
cdk.Tags.of(marketing).add('Service', 'marketing');

// On-demand DB admin task (create databases/roles, import dumps) run from inside
// the VPC. Defines a runnable task only — trigger it with scripts/db/run-sql.sh.
const dbAdmin = new DbAdminStack(app, `${cfg.projectName}-dbadmin`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
  ecr,
  imageTags,
});
cdk.Tags.of(dbAdmin).add('Service', 'dbadmin');

// Tailscale subnet router — opt-in, set tailscaleAuthKeyArn in cdk.json context
// or pass -c tailscaleAuthKeyArn=arn:... at deploy time.
// See docs/tailscale-db-access.md for the full setup guide.
const tailscaleAuthKeyArn = app.node.tryGetContext('tailscaleAuthKeyArn') as string | undefined;
if (tailscaleAuthKeyArn) {
  new TailscaleStack(app, `${cfg.projectName}-tailscale`, {
    env,
    projectName: cfg.projectName,
    vpc: network.vpc,
    dbSecurityGroup: data.dbSecurityGroup,
    tailscaleAuthKeySecretArn: tailscaleAuthKeyArn,
  });
}

// Cost monitoring — CE resources require us-east-1 regardless of project region.
new CostStack(app, `${cfg.projectName}-cost`, {
  env: { account: cfg.account, region: 'us-east-1' },
  projectName: cfg.projectName,
  alertEmail: 'alerts@example.com',
  monthlyBudgetUsd: 50,
});
