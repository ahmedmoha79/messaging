#!/usr/bin/env bash
# Installs the test stand-ins where server.js looks for browser libraries.
# Only for local end-to-end runs; Render installs the real packages.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p node_modules/@supabase/supabase-js/dist/umd node_modules/leaflet/dist
echo '{"name":"@supabase/supabase-js","version":"0.0.0-fake"}' > node_modules/@supabase/supabase-js/package.json
cp test/fake-supabase/client.js node_modules/@supabase/supabase-js/dist/umd/supabase.js
echo '{"name":"leaflet","version":"0.0.0-stub"}' > node_modules/leaflet/package.json
cp test/fake-supabase/leaflet-stub.js node_modules/leaflet/dist/leaflet.js
echo '/* stub */' > node_modules/leaflet/dist/leaflet.css
echo "Test stand-ins installed."
