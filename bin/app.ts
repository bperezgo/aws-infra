#!/usr/bin/env node
import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { ServicesStack } from '../lib/stacks/services-stack';

const imageTags = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'image-tags.json'), 'utf8'),
) as { laguna: string };

const app = new cdk.App();

const projectName = app.node.tryGetContext('projectName') || 'bryan-dev';
const environment = app.node.tryGetContext('env') || 'dev';
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('Environment', environment);
cdk.Tags.of(app).add('ManagedBy', 'cdk');

const network = new NetworkStack(app, `${projectName}-network`, {
  env,
  projectName,
});

const data = new DataStack(app, `${projectName}-data`, {
  env,
  projectName,
  vpc: network.vpc,
});

const ecr = new EcrStack(app, `${projectName}-ecr`, {
  env,
  projectName,
});

new ServicesStack(app, `${projectName}-services`, {
  env,
  projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  namespace: network.namespace,
  database: data.database,
  dbSecurityGroup: data.dbSecurityGroup,
  ecr,
  imageTags,
});
