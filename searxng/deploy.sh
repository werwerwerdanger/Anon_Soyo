#!/usr/bin/env bash
# SearXNG deploy helper.
#
# Run this ON the server (Ubuntu). It creates /opt/searxng, writes the config,
# starts the container and then verifies that the JSON API really answers.
#
#   scp -r searxng-deploy/ admin@<server>:~/
#   ssh admin@<server>
#   cd ~/searxng-deploy && bash deploy.sh
#
# Re-running is safe: the secret and the existing config are preserved unless
# you pass --force-settings.

set -euo pipefail

SEARXNG_DIR="${SEARXNG_DIR:-/opt/searxng}"
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
FORCE_SETTINGS=0
[ "${1:-}" = "--force-settings" ] && FORCE_SETTINGS=1

SRC="$(cd "$(dirname "$0")" && pwd)"

echo "=============================================="
echo "  SearXNG deploy"
echo "  target dir : $SEARXNG_DIR"
echo "  host port  : $SEARXNG_PORT"
echo "  source     : $SRC"
echo "=============================================="
echo

# ---------------------------------------------------------------- pre-flight
command -v docker >/dev/null 2>&1 || { echo "[ERROR] docker not found. Install it first."; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
    echo "[ERROR] 'docker compose' plugin not found. Install docker-compose-plugin."
    exit 1
fi
if [ ! -f "$SRC/settings.yml" ] || [ ! -f "$SRC/docker-compose.yml" ]; then
    echo "[ERROR] settings.yml / docker-compose.yml must sit next to this script."
    exit 1
fi

mkdir -p "$SEARXNG_DIR/config"

# ------------------------------------------------------------------- secret
ENV_FILE="$SEARXNG_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    SECRET="$(openssl rand -hex 32)"
    printf 'SEARXNG_SECRET=%s\nSEARXNG_PORT=%s\n' "$SECRET" "$SEARXNG_PORT" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "[ok] generated new secret in $ENV_FILE"
else
    echo "[ok] reusing existing $ENV_FILE"
    if ! grep -q '^SEARXNG_PORT=' "$ENV_FILE"; then
        printf 'SEARXNG_PORT=%s\n' "$SEARXNG_PORT" >> "$ENV_FILE"
    fi
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

# ----------------------------------------------------------------- settings
if [ -f "$SEARXNG_DIR/config/settings.yml" ] && [ "$FORCE_SETTINGS" -eq 0 ]; then
    echo "[ok] keeping existing config/settings.yml (pass --force-settings to overwrite)"
else
    sed "s/__SECRET__/$SEARXNG_SECRET/" "$SRC/settings.yml" > "$SEARXNG_DIR/config/settings.yml"
    echo "[ok] wrote $SEARXNG_DIR/config/settings.yml"
fi

cp "$SRC/docker-compose.yml" "$SEARXNG_DIR/docker-compose.yml"
echo "[ok] wrote $SEARXNG_DIR/docker-compose.yml"

# ---------------------------------------------------------------------- run
cd "$SEARXNG_DIR"
echo
echo "[..] starting container (image pull may take a while)"
docker compose up -d

echo "[..] waiting for the web server"
READY=0
for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:${SEARXNG_PORT}/" 2>/dev/null; then
        READY=1
        break
    fi
    sleep 2
done
if [ "$READY" -eq 0 ]; then
    echo "[WARN] no response after 60s. Check: docker compose logs --tail 50"
fi

# ------------------------------------------------------------------- verify
echo
echo "================= self check ================="
CHECK_URL="http://127.0.0.1:${SEARXNG_PORT}/search?q=test&format=json&language=zh-CN"
CODE="$(curl -s -o /tmp/searxng-check.json -w '%{http_code}' "$CHECK_URL" || echo 000)"
echo "  GET /search?format=json  ->  HTTP $CODE"

case "$CODE" in
    200)
        if command -v python3 >/dev/null 2>&1; then
            python3 - <<'PY' || true
import json
try:
    d = json.load(open('/tmp/searxng-check.json', encoding='utf-8'))
except Exception as e:
    print('  [ERROR] body is not JSON:', e)
    raise SystemExit
res = d.get('results') or []
print('  results from upstream engines:', len(res))
seen = {}
for x in res:
    seen[x.get('engine', '?')] = seen.get(x.get('engine', '?'), 0) + 1
if seen:
    print('  by engine:', ', '.join(f'{k}={v}' for k, v in sorted(seen.items())))
for x in res[:3]:
    print('   -', x.get('engine'), '|', (x.get('title') or '')[:60])
if not res:
    print('  [WARN] 0 results. Most likely the usable upstream engines are')
    print('         blocked from this network. Try: comment out the whole')
    print('         engines: block in config/settings.yml, then')
    print('         docker compose restart, and run this check again.')
PY
        fi
        ;;
    403)
        echo "  [ERROR] HTTP 403 - the json format is not enabled."
        echo "         Check config/settings.yml has formats: [html, json]."
        ;;
    000)
        echo "  [ERROR] could not connect at all. Is the container running?"
        ;;
    *)
        echo "  [ERROR] unexpected status. See: docker compose logs --tail 50"
        ;;
esac

# ------------------------------------------------------------------- advice
echo
echo "==================== done ===================="
echo "  local url   : http://127.0.0.1:$SEARXNG_PORT"
echo "  start/stop  : cd $SEARXNG_DIR && docker compose up -d | down"
echo "  logs        : cd $SEARXNG_DIR && docker compose logs -f"
echo
echo "  MimirLink side:"
echo "    ai.tools.webSearch.provider      = searxng"
echo "    ai.tools.webSearch.searxngBaseUrl = http://<public-ip>:$SEARXNG_PORT"
echo
echo "  SECURITY: this port is reachable from the internet if the cloud"
echo "  firewall allows it. Restrict it to your home IP, or put nginx with"
echo "  basic auth in front. An open SearXNG gets abused within hours."
echo "=============================================="
