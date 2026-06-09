import { z } from 'zod';

// CFN allows up to ~128 chars but stack/resource names get suffixes.
// Lowercase + hyphen keeps everything (S3, ECR, Cloud Map) happy.
const projectNamePattern = /^[a-z][a-z0-9-]{2,30}$/;

// Loose-semver: v1.2.3 or v1.2.3-rc1. Forces release-tag discipline.
// Reject "latest" outright — release-driven means no moving pointers.
const releaseTagPattern = /^v\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;

export const EnvironmentSchema = z.enum(['dev', 'staging', 'prod']);

export const AppConfigSchema = z.object({
  projectName: z
    .string()
    .regex(projectNamePattern, 'must be lowercase, start with a letter, 3-31 chars, hyphens allowed'),
  environment: EnvironmentSchema,
  account: z.string().regex(/^\d{12}$/, 'must be a 12-digit AWS account ID'),
  region: z.string().min(1, 'must not be empty (e.g. us-east-1)'),
  githubOwner: z.string().min(1, 'must not be empty'),
  cfTunnelLaguna: z.string().optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ImageTagsSchema = z.object({
  laguna: z
    .string()
    .regex(releaseTagPattern, 'must match vX.Y.Z (release tag) — "latest" not allowed'),
});

export type ImageTags = z.infer<typeof ImageTagsSchema>;
