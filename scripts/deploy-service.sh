#!/bin/bash
# Build, push, and deploy a service
# Usage: ./deploy-service.sh <service-name> <path-to-dockerfile-dir>
# Example: ./deploy-service.sh laguna ../../laguna-escondida-backend

set -euo pipefail

SERVICE="${1:?Usage: $0 <service-name> <path-to-source>}"
SOURCE_DIR="${2:?Usage: $0 <service-name> <path-to-source>}"
CLUSTER="bryan-dev-cluster"
REGION="us-east-1"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$SERVICE"

echo "=== Building $SERVICE ==="
docker build -t "$SERVICE:latest" "$SOURCE_DIR"

echo "=== Pushing to ECR ==="
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
docker tag "$SERVICE:latest" "$ECR_REPO:latest"
docker push "$ECR_REPO:latest"

echo "=== Deploying ==="
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment --no-cli-pager

echo "=== Done. $SERVICE deploying. ==="
echo "Watch: aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query 'services[0].deployments'"
