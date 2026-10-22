#!/usr/bin/env bash
#
# Provision an ops-console organization and user (marketing-app console-api).
# There is no sign-up: POST /internal/provision is the only way in, and it is
# blocked at the Cloudflare edge. So this goes around Cloudflare, over an SSM
# port-forward straight to the running task's port 8090.
#
# Usage:
#   scripts/console-provision.sh "<organization>" <email> [product ...]
#   scripts/console-provision.sh "Laguna Escondida" maria@example.com laguna-escondida
#
# Products default to laguna-escondida. The organization is created if new; an
# existing one just gains the user (and the products). The password is prompted
# for (min 12 characters) and the provisioning token is read from Secrets
# Manager — neither touches the CLI, shell history or this file.
#
# Prereqs: aws CLI + session-manager-plugin, jq, curl.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-bryan-dev-cluster}"
PROJECT="${PROJECT:-bryan-dev}"
LOCAL_PORT="${LOCAL_PORT:-18090}"

ORG="${1:?Usage: $0 \"<organization>\" <email> [product ...]}"
EMAIL="${2:?Usage: $0 \"<organization>\" <email> [product ...]}"
shift 2
PRODUCTS=("${@:-laguna-escondida}")

read -rsp "Password for $EMAIL (min 12 chars): " PASSWORD; echo
read -rsp "Repeat: " PASSWORD2; echo
[[ "$PASSWORD" == "$PASSWORD2" ]] || { echo "Passwords differ." >&2; exit 1; }
(( ${#PASSWORD} >= 12 )) || { echo "Password is shorter than 12 characters." >&2; exit 1; }

echo "==> Finding the console-api task..."
SERVICE="$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" \
  --query 'serviceArns[?contains(@, `ConsoleApi`)] | [0]' --output text)"
TASK="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --query 'taskArns[0]' --output text)"
[[ "$TASK" != "None" ]] || { echo "No running console-api task." >&2; exit 1; }
TASK_ID="${TASK##*/}"
RUNTIME_ID="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[?name==`app`].runtimeId | [0]' --output text)"

TOKEN="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$PROJECT/console-api/app" --query SecretString --output text \
  | jq -r .CONSOLE_PROVISION_TOKEN)"

echo "==> Port-forwarding localhost:$LOCAL_PORT -> task $TASK_ID:8090..."
aws ssm start-session --region "$REGION" \
  --target "ecs:${CLUSTER}_${TASK_ID}_${RUNTIME_ID}" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=8090,localPortNumber=$LOCAL_PORT" >/dev/null &
FORWARD_PID=$!
trap 'kill "$FORWARD_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$LOCAL_PORT/healthz" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$LOCAL_PORT/healthz" >/dev/null \
  || { echo "Port-forward did not come up." >&2; exit 1; }

echo "==> Provisioning $EMAIL in \"$ORG\" (${PRODUCTS[*]})..."
# Token and body go through private temp files, not argv, so `ps` never shows them.
TMP="$(mktemp -d)"; chmod 700 "$TMP"
trap 'kill "$FORWARD_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT
printf 'Authorization: Bearer %s\n' "$TOKEN" >"$TMP/headers"
PW="$PASSWORD" jq -n --arg org "$ORG" --arg email "$EMAIL" \
  '{organization: $org, email: $email, password: env.PW, products: $ARGS.positional}' \
  --args "${PRODUCTS[@]}" >"$TMP/body"

STATUS="$(curl -sS -o "$TMP/response" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$LOCAL_PORT/internal/provision" \
  -H @"$TMP/headers" -H 'Content-Type: application/json' --data-binary @"$TMP/body")"
jq . "$TMP/response" 2>/dev/null || cat "$TMP/response"
if [[ "$STATUS" == 201 ]]; then
  echo "✓ Provisioned. Sign in at https://console.laguna-escondida.com"
else
  echo "✗ Provisioning failed (HTTP $STATUS)." >&2
  exit 1
fi
