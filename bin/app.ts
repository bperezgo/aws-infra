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

const app = new cdk.App();

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

const data = new DataStack(app, `${cfg.projectName}-data`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
});

const ecr = new EcrStack(app, `${cfg.projectName}-ecr`, {
  env,
  projectName: cfg.projectName,
});

new CiStack(app, `${cfg.projectName}-ci`, {
  env,
  projectName: cfg.projectName,
  ecr,
  githubOwner: cfg.githubOwner,
});

new ServicesStack(app, `${cfg.projectName}-services`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  namespace: network.namespace,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
  ecr,
  imageTags,
});

// On-demand DB admin task (create databases/roles, import dumps) run from inside
// the VPC. Defines a runnable task only — trigger it with scripts/db/run-sql.sh.
new DbAdminStack(app, `${cfg.projectName}-dbadmin`, {
  env,
  projectName: cfg.projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
});
