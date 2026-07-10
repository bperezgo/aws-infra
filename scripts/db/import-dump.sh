#!/usr/bin/env bash
#
# Import a DigitalOcean pg_dump into the private RDS `laguna_escondida` database,
# via the in-VPC bryan-dev-dbadmin Fargate task. This is the counterpart to
# run-sql.sh: run-sql.sh injects small SQL through the task command; a real data
# dump is far too big for that (ECS run-task overrides cap ~8 KB), so we hand the
# task a short-lived S3 PRESIGNED URL and let it stream the dump with wget and pipe
# it into pg_restore — no IAM/image change, and the dump bytes never touch the CLI.
#
# The dump must be data-only + custom format:
#   pg_dump -Fc --data-only --no-owner \
#     --exclude-table-data='<migration table>' "$DO_CONN" -f laguna.dump
#
# Restore runs as master dbadmin (from the RDS secret, already wired into the task):
#   - PGOPTIONS session_replication_role=replica  -> skip FK-order checks during load
#     (dbadmin is rds_superuser, which RDS permits to set this).
#   - --role=laguna_app  -> SET ROLE to the table owner so INSERTs are allowed and
#     objects stay owned correctly. dbadmin is a member of laguna_app.
#   - --no-owner --data-only  -> load rows only, into the app-migrated schema.
#
# Usage:
#   scripts/db/import-dump.sh s3://my-bucket/tmp/laguna.dump   # presigns for you
#   scripts/db/import-dump.sh 'https://…already-presigned…'    # use a URL directly
#
# Prereqs:
#   - pnpm cdk deploy bryan-dev-dbadmin        (once, to create the task)
#   - scripts/db/run-sql.sh scripts/db/truncate-data.sql   (empty target tables)
#   - app scaled to 0 (no writers) during the import
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${DBADMIN_STACK:-bryan-dev-dbadmin}"
DB="${TARGET_DB:-laguna_escondida}"
DB_ROLE="${DB_ROLE:-laguna_app}"
SRC="${1:?usage: import-dump.sh <s3://bucket/key | presigned-url>}"

# An s3:// URI is turned into a presigned GET URL the task can wget (valid 1h).
if [[ "$SRC" == s3://* ]]; then
  echo "==> Presigning $SRC (valid 3600s)..."
  URL="$(aws s3 presign "$SRC" --expires-in 3600 --region "$REGION")"
else
  URL="$SRC"
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

# Container command: download the dump, then pg_restore data-only as laguna_app.
# The URL is passed as $0 to `sh -c` (like run-sql.sh) so there is zero quoting to
# get wrong. PGHOST/PGPORT/PGUSER/PGPASSWORD/PGSSLMODE all come from the task def.
CMD='set -e
wget -O /tmp/laguna.dump "$0"
echo "downloaded $(wc -c < /tmp/laguna.dump) bytes"
PGOPTIONS="-c session_replication_role=replica" \
  pg_restore --no-owner --data-only --role='"$DB_ROLE"' \
  --single-transaction -v -d '"$DB"' /tmp/laguna.dump
echo "restore complete"'

OVERRIDES_FILE="$(mktemp)"
trap 'rm -f "$OVERRIDES_FILE"' EXIT
python3 - "$CMD" "$URL" > "$OVERRIDES_FILE" <<'PY'
import json, sys
cmd, url = sys.argv[1], sys.argv[2]
print(json.dumps({
    "containerOverrides": [{
        "name": "dbadmin",
        "command": ["sh", "-c", cmd, url],
    }]
}))
PY

echo "==> Launching import task in '$CLUSTER'..."
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

echo "==> Waiting for the import to finish (pull + download + restore)..."
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
  echo "Import FAILED — see task output above." >&2
  exit 1
fi
echo "Done. Run scripts/db/run-sql.sh scripts/db/inspect.sql to verify row counts."
