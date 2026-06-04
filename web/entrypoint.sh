#!/bin/sh
set -e

# Build the agent entries JSON array from environment variables
AGENT_ENTRIES=""
i=1
while [ $i -le 5 ]; do
  URL_VAR="AGENT_${i}_URL"
  NAME_VAR="AGENT_${i}_NAME"
  URL=$(eval echo "\${$URL_VAR:-}")
  NAME=$(eval echo "\${$NAME_VAR:-}")

  if [ -n "$URL" ]; then
    if [ -n "$AGENT_ENTRIES" ]; then
      AGENT_ENTRIES="${AGENT_ENTRIES},"
    fi
    ENTRY="{ \"name\": \"${NAME:-Agent ${i}}\", \"url\": \"${URL}\" }"
    AGENT_ENTRIES="${AGENT_ENTRIES}
  ${ENTRY}"
  fi
  i=$((i + 1))
done

# Default to a local agent if nothing is configured
if [ -z "$AGENT_ENTRIES" ]; then
  AGENT_ENTRIES='
  { "name": "Local Agent", "url": "http://localhost:8081" }'
fi

export AGENT_ENTRIES

# TEST_MODE controls whether the browser uses WebSocket or plain HTTP for tests.
# 'websocket' (default) — bypasses proxy upload buffering (e.g. Cloudflare).
# 'http'                — broader firewall/proxy compatibility.
SPEEDTEST_MODE="${TEST_MODE:-websocket}"
export SPEEDTEST_MODE

# Compute a short content hash from the static assets for cache-busting
APP_VERSION=$(cat /usr/share/nginx/html/app.js /usr/share/nginx/html/style.css | md5sum | cut -c1-8)
export APP_VERSION

envsubst '${AGENT_ENTRIES} ${SPEEDTEST_MODE}' < /usr/share/nginx/html/config.js.tmpl > /usr/share/nginx/html/config.js
envsubst '${APP_VERSION}' < /usr/share/nginx/html/index.html.tmpl > /usr/share/nginx/html/index.html

exec nginx -g "daemon off;"
