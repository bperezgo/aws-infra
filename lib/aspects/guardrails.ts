import {
  Annotations,
  CfnDeletionPolicy,
  CfnResource,
  IAspect,
  Stack,
} from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import { IConstruct } from 'constructs';

// Resources that hold data we must never lose when a stack is deleted.
const STATEFUL_TYPES = new Set<string>([
  'AWS::S3::Bucket',
  'AWS::RDS::DBInstance',
  'AWS::ECR::Repository',
  'AWS::EFS::FileSystem',
]);

const SAFE_DELETION_POLICIES = new Set<CfnDeletionPolicy>([
  CfnDeletionPolicy.RETAIN,
  CfnDeletionPolicy.SNAPSHOT,
]);

/**
 * Guardrails — the rules already documented in the stack comments, made
 * executable. Applied app-wide in bin/app.ts, so a violation raises a synth-time
 * error, which fails the pre-commit hook AND CI. This is the enforcement layer:
 * it catches a non-compliant resource that nobody wrote a specific assertion for
 * (e.g. a *new* bucket added next year).
 *
 * Each rule cites the source comment it enforces. Keep this list short and
 * high-signal — it must never false-positive on the intentional cost tradeoffs
 * (single-AZ RDS, public-subnet tasks, Fargate Spot). Those are choices, not bugs.
 */
export class Guardrails implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;

    // Cost invariant — network-stack.ts: "No NAT Gateway ... use VPC endpoints".
    if (node.cfnResourceType === 'AWS::EC2::NatGateway') {
      this.err(node, 'NAT gateways are banned — use VPC endpoints (network-stack.ts).');
    }

    // Data durability — data-stack.ts / ecr-stack.ts: RETAIN / SNAPSHOT, never
    // wipe the registry or the database on a stack delete.
    if (STATEFUL_TYPES.has(node.cfnResourceType)) {
      const policy = node.cfnOptions.deletionPolicy;
      if (!policy || !SAFE_DELETION_POLICIES.has(policy)) {
        this.err(
          node,
          `${node.cfnResourceType} must set RemovalPolicy RETAIN or SNAPSHOT ` +
            `(no silent data loss). Found: ${policy ?? 'Delete/none'}.`,
        );
      }
    }

    // Private + encrypted storage — data-stack.ts (assets bucket).
    if (node instanceof s3.CfnBucket) {
      if (!this.allPublicAccessBlocked(node)) {
        this.err(node, 'S3 bucket must block ALL public access.');
      }
      if (!this.hasEncryption(node)) {
        this.err(node, 'S3 bucket must enable server-side encryption.');
      }
    }

    // Encrypted RDS — data-stack.ts: storageEncrypted: true.
    if (node instanceof rds.CfnDBInstance) {
      if (Stack.of(node).resolve(node.storageEncrypted) !== true) {
        this.err(node, 'RDS instance must set storageEncrypted: true.');
      }
    }
  }

  private err(node: CfnResource, msg: string): void {
    // addError fails `cdk synth`. Use the construct path so the message points at
    // the offending resource.
    Annotations.of(node).addError(`[Guardrails] ${msg}`);
  }

  private allPublicAccessBlocked(bucket: s3.CfnBucket): boolean {
    const cfg = Stack.of(bucket).resolve(bucket.publicAccessBlockConfiguration);
    if (!cfg || typeof cfg !== 'object') return false;
    // Normalize keys (resolved casing varies) and require all four flags true.
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) lower[k.toLowerCase()] = v;
    return (
      lower['blockpublicacls'] === true &&
      lower['blockpublicpolicy'] === true &&
      lower['ignorepublicacls'] === true &&
      lower['restrictpublicbuckets'] === true
    );
  }

  private hasEncryption(bucket: s3.CfnBucket): boolean {
    const enc = Stack.of(bucket).resolve(bucket.bucketEncryption);
    return !!enc && typeof enc === 'object';
  }
}
