# aws-infra — agent & contributor guide

AWS CDK (TypeScript) app that provisions the infrastructure for the laguna backend and
related services. Deliberately **cost-optimized** and **release-driven**. Read this before
changing infra — several "odd" choices are intentional and enforced.

## Commands

| Command | What |
|---|---|
| `pnpm test` | CDK assertion tests (`node:test`, offline, ~1s) |
| `pnpm test:watch` | the inner dev loop — keep it running |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm synth` | synth all stacks (needs AWS env/creds for Tailscale) |
| `pnpm diff` / `pnpm deploy` | against real AWS |
| `pnpm obs:up` / `obs:down` / `smoke` | local observability harness (see `observability/`) |

## The harness (how work flows)

1. State the change as a **red assertion test first** (`test/*.test.ts`) — that's the spec.
2. Write the CDK; `pnpm test:watch` turns it green.
3. `git commit` runs `.githooks/pre-commit`: **typecheck → test → offline synth**. Synth
   runs the **Guardrails** aspect, so a rule violation blocks the commit.
4. PR → `.github/workflows/ci.yml` re-runs the same rungs (keyless). Keep `main` branch-protected.
5. `pnpm deploy` is manual.

Bypass the hook only in emergencies: `git commit --no-verify`.

## Rules the Guardrails aspect enforces (`lib/aspects/guardrails.ts`)

These fail `cdk synth` app-wide — write compliant code the first time:

- **No NAT gateways.** Use VPC endpoints. (`network-stack.ts`)
- **Stateful resources** (S3, RDS, ECR, EFS) must set `RemovalPolicy.RETAIN` or `SNAPSHOT`.
- **S3 buckets**: block ALL public access + server-side encryption.
- **RDS**: `storageEncrypted: true`.

When you add a *specific* invariant you care about, also add an **assertion test** for it —
the aspect is the broad net; assertions pin the details.

## Conventions

- **Config is validated, no silent defaults.** All input flows through `lib/config` (zod).
  `projectName`/`env`/`githubOwner` come from `cdk.json` context; `account`/`region` from env.
- **Release-driven images.** Container tags live in `image-tags.json` (validated: `vX.Y.Z`,
  never `latest`). Bump the file + redeploy to roll a service.
- **Secrets never in the template.** Reference Secrets Manager by name (`fromSecretNameV2`);
  never inline secret *values* as env. App/infra secrets are created out-of-band.
- **New ECS service** → use the `EcsService` construct (`lib/constructs/ecs-service.ts`),
  add its ECR repo to `EcrStack`, add the image tag to `image-tags.json`. Fargate **Spot**
  is the default. Cross-stack SG ingress is added on a re-imported SG handle so the rule
  lands in the consuming stack (avoids cycles) — follow the laguna pattern.
- **Every stack is tagged** `Project`/`Environment`/`ManagedBy`/`Service` in `bin/app.ts`.

## Gotchas

- **`Match.arrayWith` is order-sensitive.** For "contains X" checks use a single-element
  `arrayWith` (see the env-var assertions in `test/services-stack.test.ts`).
- **Fargate CPU/memory come in fixed pairs.** The tunnel sidecar doubles memory (512→1024).
- **Offline synth** (hook/CI) uses account `123456789012` (its AZs are cached in
  `cdk.context.json`) and `-c tailscaleAuthKeyArn=` to skip the one stack needing a live lookup.
- **Tailscale stack is opt-in** via `tailscaleAuthKeyArn` context; it needs an SSM AMI lookup.
- Docs under `docs/` are kept local — don't commit them.

## Not enabled (on purpose)

`cdk-nag` is **not** wired: its AwsSolutions pack flags the intentional cost tradeoffs
(single-AZ RDS, public-subnet tasks, no WAF) and would need a large suppression file. The
custom Guardrails aspect covers the rules that actually matter here. Add cdk-nag later behind
a context flag if a prod/compliance environment needs it.
