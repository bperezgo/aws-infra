import * as fs from 'fs';
import * as path from 'path';
import type * as cdk from 'aws-cdk-lib';
import { z, ZodError } from 'zod';
import {
  AppConfigSchema,
  ImageTagsSchema,
  type AppConfig,
  type ImageTags,
} from './schema';

/**
 * Validate raw input against a schema. On failure, throw a single error
 * listing every issue at once — never one-at-a-time. Includes a hint per
 * field so the user knows where to set the value.
 */
function parseOrThrow<T>(
  schema: z.ZodType<T>,
  input: unknown,
  source: string,
  hints: Record<string, string> = {},
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const field = issue.path.join('.') || '(root)';
    const hint = hints[field];
    return `  - ${field}: ${issue.message}${hint ? ` — ${hint}` : ''}`;
  });

  throw new Error(`${source} validation failed:\n${lines.join('\n')}`);
}

export function loadAppConfig(app: cdk.App): AppConfig {
  const raw = {
    projectName: app.node.tryGetContext('projectName'),
    environment: app.node.tryGetContext('env'),
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION,
    githubOwner: app.node.tryGetContext('githubOwner'),
  };

  return parseOrThrow(AppConfigSchema, raw, 'AppConfig', {
    projectName: 'set in cdk.json context or pass -c projectName=<name>',
    environment: 'set in cdk.json context or pass -c env=dev|staging|prod',
    account: 'export CDK_DEFAULT_ACCOUNT or configure AWS credentials',
    region: 'export CDK_DEFAULT_REGION=us-east-1 (or AWS_REGION)',
    githubOwner: 'set in cdk.json context or pass -c githubOwner=<gh-user-or-org>',
  });
}

export function loadImageTags(repoRoot: string): ImageTags {
  const filePath = path.join(repoRoot, 'image-tags.json');

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read image-tags.json at ${filePath}: ${reason}`);
  }

  return parseOrThrow(ImageTagsSchema, raw, 'image-tags.json', {
    laguna: 'bump to the release tag pushed to ECR (e.g. "v0.1.0")',
    whatsappAgent: 'bump to the marketing-app release tag pushed to ECR (e.g. "v0.1.0")',
    cloudflared: 'pin to a cloudflared release tag (e.g. "2026.7.1") — not "latest"',
    alloy: 'pin to a grafana/alloy release tag (e.g. "v1.18.1") — not "latest"',
  });
}
