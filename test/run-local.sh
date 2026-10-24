#!/usr/bin/env bash
# Starts the fake backend + app server, runs the browser walkthrough, stops both.
set -uo pipefail
cd "$(dirname "$0")/.."
test/setup-local.sh >/dev/null
node test/fake-supabase/server.mjs > /tmp/wazambi-fake.log 2>&1 & FAKE=$!
SUPABASE_URL=http://127.0.0.1:54321 PORT=3000 node server.js > /tmp/wazambi-server.log 2>&1 & APP=$!
trap 'kill $FAKE $APP 2>/dev/null' EXIT
sleep 1.2
python3 test/e2e.py "$@"
