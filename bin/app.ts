#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ServicesStack } from '../lib/stacks/services-stack';

const app = new cdk.App();

const projectName = app.node.tryGetContext('projectName') || 'bryan-dev';
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const network = new NetworkStack(app, `${projectName}-network`, {
  env,
  projectName,
});

const data = new DataStack(app, `${projectName}-data`, {
  env,
  projectName,
  vpc: network.vpc,
});

new ServicesStack(app, `${projectName}-services`, {
  env,
  projectName,
  vpc: network.vpc,
  cluster: network.cluster,
  namespace: network.namespace,
  database: data.database,
  assetsBucket: data.assetsBucket,
  cdnDomain: data.cdnDomain,
});
