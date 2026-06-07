# AWS Infra — TODO

## Prerequisites
- [ ] Install AWS CLI and configure credentials
- [ ] Install CDK CLI (`npm install -g aws-cdk`)
- [ ] Run `npx cdk bootstrap` (one-time per account/region)
- [ ] Create CloudFlare account (free tier)

## CloudFlare Tunnels
- [ ] Create tunnel for ai-agents → `agents.yourdomain.com`
- [ ] Create tunnel for laguna → `laguna.yourdomain.com`
- [ ] Create tunnel for living-uterus → `uterus.yourdomain.com`
- [ ] Save tunnel tokens securely

## ECR Repos
- [ ] Create `ai-agents` ECR repository
- [ ] Create `laguna-escondida` ECR repository
- [ ] Create `living-uterus` ECR repository

## Dockerize Services
- [ ] Dockerfile for ai-agents (new project)
- [ ] Dockerfile for laguna-escondida-backend (migrate from Digital Ocean)
- [ ] Dockerfile for living-uterus backend

## Deploy
- [ ] First deploy: `npx cdk deploy --all` with tunnel tokens
- [ ] Create per-service databases in RDS (ai_agents, laguna, living_uterus)
- [ ] Enable pgvector extension for living-uterus RAG (`CREATE EXTENSION vector;`)
- [ ] Test CloudFlare tunnel routing per subdomain
- [ ] Migrate laguna-escondida data from Digital Ocean

## Post-Deploy
- [ ] Upload living-uterus video assets to S3
- [ ] Configure CloudFront behaviors for video delivery
- [ ] Set up CI/CD (GitHub Actions → ECR → ECS deploy)
- [ ] Set up Terraform remote state (S3 backend) if needed for CDK state sharing
- [ ] Monitor costs in AWS Cost Explorer

## Future Services
- [ ] Add new services as needed (just add EcsService construct + CloudFlare tunnel)
- [ ] Evaluate if any service needs GPU (EC2 launch type instead of Fargate)
- [ ] Consider adding a shared Redis/ElastiCache if caching needed
