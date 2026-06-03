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
envsubst '${AGENT_ENTRIES}' < /usr/share/nginx/html/config.js.tmpl > /usr/share/nginx/html/config.js

exec nginx -g "daemon off;"
