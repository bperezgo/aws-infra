#!/bin/bash
# Toggle ECS service on/off
# Usage: ./scripts/service-toggle.sh <service-name> <on|off>

set -euo pipefail

CLUSTER="bryan-dev-cluster"
SERVICE="${1:?Usage: $0 <service-name> <on|off>}"
ACTION="${2:?Usage: $0 <service-name> <on|off>}"

case "$ACTION" in
  on)
    echo "Starting $SERVICE..."
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 --no-cli-pager
    echo "$SERVICE started."
    ;;
  off)
    echo "Stopping $SERVICE..."
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 --no-cli-pager
    echo "$SERVICE stopped. $0 cost."
    ;;
  *)
    echo "Usage: $0 <service-name> <on|off>"
    exit 1
    ;;
esac
