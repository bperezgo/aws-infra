import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { Guardrails } from '../lib/aspects/guardrails';

// Test the enforcement layer both ways: it must NOT false-positive on compliant
// infra (or it would block every commit), and it MUST fire on violations (or it
// enforces nothing).
function stackWith(build: (stack: cdk.Stack) => void): cdk.Stack {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  cdk.Aspects.of(stack).add(new Guardrails());
  build(stack);
  return stack;
}

describe('Guardrails aspect', () => {
  test('passes a private, encrypted, retained bucket (no false positive)', () => {
    const stack = stackWith((s) => {
      new s3.Bucket(s, 'Good', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    });
    Annotations.fromStack(stack).hasNoError('*', Match.stringLikeRegexp('Guardrails'));
  });

  test('fails a public, unencrypted, destroyable bucket', () => {
    const stack = stackWith((s) => {
      new s3.Bucket(s, 'Bad', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS, // not ALL
        encryption: s3.BucketEncryption.UNENCRYPTED,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError('*', Match.stringLikeRegexp('block ALL public access'));
    annotations.hasError('*', Match.stringLikeRegexp('server-side encryption'));
    annotations.hasError('*', Match.stringLikeRegexp('RETAIN or SNAPSHOT'));
  });
});
