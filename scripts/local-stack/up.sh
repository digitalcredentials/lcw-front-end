#!/usr/bin/env bash
# Brings up everything the local stack needs except the two sam APIs and the
# Vite dev server, which run in the foreground in their own terminals.
#
# Idempotent: safe to re-run. See AGENTS.md ("Local stack") for the full flow.
set -euo pipefail

BE_REPO="${BE_REPO:-$(cd "$(dirname "$0")/../../.." && pwd)/lcw-back-end}"
WAS_REPO="${WAS_REPO:-$(cd "$(dirname "$0")/../../.." && pwd)/was-server-aws}"
HERE="$(cd "$(dirname "$0")" && pwd)"

for repo in "$BE_REPO" "$WAS_REPO"; do
  [ -d "$repo" ] || { echo "missing repo: $repo" >&2; exit 1; }
done

echo "==> docker network"
docker network inspect lcw-local >/dev/null 2>&1 || docker network create lcw-local >/dev/null

# DynamoDB Local needs -sharedDb: without it, tables are namespaced per
# access-key/region pair, and the seed script and the Lambdas end up looking at
# two different namespaces.
echo "==> dynamodb-local (:8000)"
if ! docker ps --format '{{.Names}}' | grep -qx lcw-dynamodb; then
  docker rm -f lcw-dynamodb >/dev/null 2>&1 || true
  docker run -d --name lcw-dynamodb --network lcw-local -p 8000:8000 \
    amazon/dynamodb-local:latest \
    -jar DynamoDBLocal.jar -inMemory -sharedDb >/dev/null
fi

echo "==> minio (:9000, console :9001)"
if ! docker ps --format '{{.Names}}' | grep -qx lcw-minio; then
  docker rm -f lcw-minio >/dev/null 2>&1 || true
  docker run -d --name lcw-minio --network lcw-local -p 9000:9000 -p 9001:9001 \
    -e MINIO_ROOT_USER=localtest -e MINIO_ROOT_PASSWORD=localtest \
    minio/minio:latest server /data --console-address ":9001" >/dev/null
fi

echo "==> waiting for the substitutes"
for _ in $(seq 1 60); do
  curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1 && break
  sleep 1
done

# sam local reads .aws-sam/build, so every source change needs a rebuild, and
# every rebuild drops the injected environment and needs re-patching.
echo "==> sam build + patch (was-server-aws)"
(cd "$WAS_REPO" && sam build >/dev/null)
node "$HERE/patch-built-template.mjs" "$WAS_REPO/.aws-sam/build/template.yaml"

echo "==> sam build + patch (lcw-back-end)"
(cd "$BE_REPO" && sam build >/dev/null)
node "$HERE/patch-built-template.mjs" "$BE_REPO/.aws-sam/build/template.yaml"

# The login function's TABLE_NAME is a !Ref, which sam local resolves to the
# literal logical id, so it needs this override file.
if [ ! -f "$BE_REPO/env.json" ]; then
  echo '{ "LcwLoginFunction": { "TABLE_NAME": "wallet-test" } }' > "$BE_REPO/env.json"
  echo "wrote $BE_REPO/env.json"
fi

echo "==> seeding the demo account and space"
(cd "$HERE" && npm install --silent >/dev/null 2>&1 || true)
node "$HERE/seed.mjs"

cat <<'NEXT'

Ready. Now start the three foreground processes, each in its own terminal:

  # 1. was-server-aws (the space) on :3000
  cd ../was-server-aws && sam local start-api --port 3000 --region us-east-1 \
    --docker-network lcw-local

  # 2. lcw-back-end (the login API) on :3001
  cd ../lcw-back-end && sam local start-api --port 3001 --region us-east-1 \
    --env-vars env.json --docker-network lcw-local --warm-containers EAGER

  # 3. the front end on :5173
  npm run dev

Then sign in at http://localhost:5173 as jc.chartrand@gmail.com
with the passphrase: my-secret-seed-that-is-long-enou
NEXT
