#!/usr/bin/env bash
#
# Apply marketing-app migrations to the private RDS instance via the one-off
# migrate task in the bryan-dev-dbadmin stack. Run it BEFORE deploying a new
# whatsapp-agent tag: the service refuses to start below its schema version.
#
# Usage:
#   scripts/db/migrate-marketing.sh              # up (default)
#   scripts/db/migrate-marketing.sh version
#   scripts/db/migrate-marketing.sh down 1       # rollback = previous image + one step down
#
# The image (and so the migrations) is the whatsappAgent tag in image-tags.json,
# baked into the task def — bump the tag and `cdk deploy bryan-dev-dbadmin` first.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${DBADMIN_STACK:-bryan-dev-dbadmin}"
if [[ $# -eq 0 ]]; then set -- up; fi

OUTPUTS_JSON="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json)"

get_output() {
  python3 -c "import sys,json; o=json.load(sys.stdin); print(next(x['OutputValue'] for x in o if x['OutputKey']=='$1'))"
}

CLUSTER="$(printf '%s' "$OUTPUTS_JSON" | get_output ClusterName)"
TASKDEF="$(printf '%s' "$OUTPUTS_JSON" | get_output MarketingMigrateTaskDefArn)"
SG="$(printf '%s' "$OUTPUTS_JSON" | get_output AdminSecurityGroupId)"
SUBNETS="$(printf '%s' "$OUTPUTS_JSON" | get_output PublicSubnetIds)"
LOG_GROUP="$(printf '%s' "$OUTPUTS_JSON" | get_output LogGroupName)"

# Keep the task def's "-path … -database <url>" and swap its trailing "up" for
# the requested subcommand, so the URL is defined in one place (the stack).
OVERRIDES_FILE="$(mktemp)"
trap 'rm -f "$OVERRIDES_FILE"' EXIT
aws ecs describe-task-definition --task-definition "$TASKDEF" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[?name=='migrate'].command | [0]" --output json \
  | python3 -c '
import json, sys
base = json.load(sys.stdin)
assert base[-1] == "up", base
print(json.dumps({"containerOverrides": [{"name": "migrate", "command": base[:-1] + sys.argv[1:]}]}))
' "$@" > "$OVERRIDES_FILE"

echo "==> migrate $* (task def ${TASKDEF##*/})"
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides "file://$OVERRIDES_FILE" \
  --region "$REGION" \
  --query 'tasks[0].taskArn' --output text)"

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "Failed to start task." >&2
  exit 1
fi
TASK_ID="${TASK_ARN##*/}"
echo "    task: $TASK_ID"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

echo "==> Task output:"
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "migrate/migrate/$TASK_ID" \
  --region "$REGION" \
  --query 'events[*].message' --output text 2>/dev/null || echo "(no logs captured)"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
echo "==> Exit code: $EXIT_CODE"
[[ "$EXIT_CODE" == "0" ]] || { echo "migrate FAILED — see output above." >&2; exit 1; }
