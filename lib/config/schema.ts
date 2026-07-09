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
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ImageTagsSchema = z.object({
  laguna: z
    .string()
    .regex(releaseTagPattern, 'must match vX.Y.Z (release tag) — "latest" not allowed'),
  // Third-party sidecar (cloudflared) uses calendar versioning (YYYY.M.P) that
  // we don't control, so no strict pattern — just a non-empty tag. A wrong tag
  // fails loudly at image pull, and the point is only to avoid the moving
  // "latest" pointer that silently re-pulls on every task placement.
  cloudflared: z.string().min(1, 'must not be empty (e.g. "2026.7.1") — avoid "latest"'),
});

export type ImageTags = z.infer<typeof ImageTagsSchema>;
