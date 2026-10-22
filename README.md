# AWS Infrastructure (CDK)

Personal project infrastructure on AWS using CDK TypeScript.

## Architecture

- **Compute**: ECS Fargate (Spot) — pay only when running
- **Ingress**: CloudFlare Tunnel — free SSL, routing, DDoS protection
- **Database**: RDS PostgreSQL (shared instance, multiple databases)
- **Storage**: S3 + CloudFront for static assets and video
- **Cost target**: ~$12-25/month with all services running

## Stacks

| Stack | What |
|-------|------|
| `network` | VPC, subnets, VPC endpoints, ECS cluster, service discovery |
| `data` | RDS PostgreSQL, S3 bucket, CloudFront CDN |
| `services` | All ECS services (ai-agents, laguna, living-uterus) |
| `marketing` | marketing-app WhatsApp agent (`whatsapp-agent`) |
| `console` | marketing-app ops console (`console-api`, which serves `console-web`) |
| `dbadmin` | On-demand DB admin task and the marketing migrate task |

## Setup

```bash
pnpm install
pnpm cdk bootstrap   # first time only

# Set tunnel tokens
pnpm cdk deploy --all \
  -c cfTunnelAiAgents=<token> \
  -c cfTunnelLaguna=<token> \
  -c cfTunnelLivingUterus=<token>
```

## Adding a New Service

1. Add a new `EcsService` construct in `lib/stacks/services-stack.ts`
2. Add CloudFlare tunnel token context variable
3. `pnpm cdk deploy bryan-dev-services`

## Turn Services On/Off

```bash
# Off (stop paying)
./scripts/service-toggle.sh ai-agents off

# On
./scripts/service-toggle.sh ai-agents on
```

## Deploy a Service

```bash
./scripts/deploy-service.sh laguna ../laguna-escondida-backend
```

## marketing-app: releases and the ops console

A `v*` tag in marketing-app pushes three images to ECR at that tag:
`whatsapp-agent`, `marketing-migrations` and `console-api`. Migrations always run
**before** a service rolls: both services refuse to boot on an older schema.

```bash
# 1. Bump image-tags.json: "whatsappAgent" (agent + migrations) and/or "consoleApi"
pnpm cdk deploy -e bryan-dev-dbadmin        # picks up the new migrations image
./scripts/db/migrate-marketing.sh           # only if the release has new migrations
pnpm cdk deploy -e bryan-dev-marketing      # roll the agent
pnpm cdk deploy -e bryan-dev-console        # roll the console
```

Always deploy with `-e`: without it CDK also deploys the stack's dependencies.

### The ops console

- **URL:** https://console.laguna-escondida.com (its own Cloudflare Tunnel to
  `localhost:8090`). The web app is built into the `console-api` image and served
  from the same origin, so there is one service, not two.
- **No sign-up.** Organizations and users are created through
  `POST /internal/provision`, which a Cloudflare WAF custom rule on
  `laguna-escondida.com` blocks from the internet (403). Provision over an SSM
  port-forward instead:

  ```bash
  ./scripts/console-provision.sh "Laguna Escondida" someone@example.com [product ...]
  ```

  Products default to `laguna-escondida`. An existing organization name adds the
  user to that organization. The script prompts for the password (min 12 chars)
  and reads the provisioning token from Secrets Manager.
- **Secrets:** `bryan-dev/console-api/app` holds `DB_PASSWORD` (the
  `marketing_console_svc` login, set by `scripts/db/bootstrap-marketing.sql`) and
  `CONSOLE_PROVISION_TOKEN`. `bryan-dev/console-api/infra` holds `CF_TUNNEL_TOKEN`.
  The secrets are read when a task starts: after changing one, force a new deployment.
- **Trace links** stay hidden until `CONSOLE_TRACE_URL` is set (needs the Langfuse
  project id).

