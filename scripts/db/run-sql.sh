#!/usr/bin/env bash
#
# Run a .sql file against the private RDS instance via a one-off Fargate task
# (defined in the bryan-dev-dbadmin stack). This is the DELIBERATE, decoupled way
# to do data-plane work (create databases/roles, import a dump) — it is NOT part
# of `cdk deploy`, so it can never fire on a stack destroy/replace.
#
# Usage:
#   scripts/db/run-sql.sh [path/to/file.sql]     # defaults to scripts/db/bootstrap.sql
#
# Prereqs:
#   - pnpm cdk deploy bryan-dev-dbadmin   (once, to create the runnable task)
#   - aws CLI + credentials, python3 (ships with macOS)
#
# The SQL runs as the RDS master user (dbadmin). Connection creds are injected
# into the task from Secrets Manager — they never appear here or on the CLI.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${DBADMIN_STACK:-bryan-dev-dbadmin}"
SQL_FILE="${1:-scripts/db/bootstrap.sql}"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "SQL file not found: $SQL_FILE" >&2
  exit 1
fi

echo "==> Reading outputs from stack '$STACK' ($REGION)..."
OUTPUTS_JSON="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json)"

get_output() {
  python3 -c "import sys,json; o=json.load(sys.stdin); print(next(x['OutputValue'] for x in o if x['OutputKey']=='$1'))"
}

CLUSTER="$(printf '%s' "$OUTPUTS_JSON" | get_output ClusterName)"
TASKDEF="$(printf '%s' "$OUTPUTS_JSON" | get_output TaskDefArn)"
SG="$(printf '%s' "$OUTPUTS_JSON" | get_output AdminSecurityGroupId)"
SUBNETS="$(printf '%s' "$OUTPUTS_JSON" | get_output PublicSubnetIds)"
LOG_GROUP="$(printf '%s' "$OUTPUTS_JSON" | get_output LogGroupName)"

# Build run-task overrides. The SQL is passed to `sh -c` as $0 (so there is zero
# quoting to get wrong) and piped into psql, which processes \gexec etc. from stdin.
OVERRIDES_FILE="$(mktemp)"
trap 'rm -f "$OVERRIDES_FILE"' EXIT
python3 - "$SQL_FILE" > "$OVERRIDES_FILE" <<'PY'
import json, sys
sql = open(sys.argv[1]).read()
print(json.dumps({
    "containerOverrides": [{
        "name": "dbadmin",
        "command": ["sh", "-c", "printf '%s' \"$0\" | psql -v ON_ERROR_STOP=1", sql],
    }]
}))
PY

echo "==> Launching one-off task in '$CLUSTER'..."
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

echo "==> Waiting for the task to finish (pull + connect + run)..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

echo "==> Task output:"
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "dbadmin/dbadmin/$TASK_ID" \
  --region "$REGION" \
  --query 'events[*].message' --output text 2>/dev/null || echo "(no logs captured)"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
REASON="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].stoppedReason' --output text)"

echo "==> Exit code: $EXIT_CODE  (stopped reason: $REASON)"
if [[ "$EXIT_CODE" != "0" ]]; then
  echo "SQL run FAILED — see task output above." >&2
  exit 1
fi
echo "Done."
