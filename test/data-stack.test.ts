import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthData, TEST_PROJECT } from './support/harness';

// Guards the "don't accidentally lose customer data / expose a bucket" invariants.
// Removing storageEncrypted, deletionProtection, RETAIN, or the public-access block
// should be a loud test failure, not a quiet diff.
describe('DataStack', () => {
  const { template } = synthData();

  test('assets bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `${TEST_PROJECT}-laguna-assets`,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('assets bucket is retained on stack deletion', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('RDS instance is encrypted and deletion-protected', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
      DeletionProtection: true,
      DBInstanceIdentifier: `${TEST_PROJECT}-postgres`,
    });
  });

  test('RDS instance snapshots on delete (no silent data loss)', () => {
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
    });
  });

  test('DB security group is not open to all outbound', () => {
    // allowAllOutbound:false → CDK drops the wide-open egress rule and inserts a
    // 255.255.255.255/32 deny-all placeholder instead. Its presence proves egress
    // is locked down.
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'RDS PostgreSQL',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ CidrIp: '255.255.255.255/32' }),
      ]),
    });
  });
});
