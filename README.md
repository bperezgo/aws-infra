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
