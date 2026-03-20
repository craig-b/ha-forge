#!/usr/bin/env sh
set -e

echo "Starting HA Forge add-on..."
echo "Node: $(node --version 2>&1 || echo 'NOT FOUND')"
echo "Entry point: $(ls -la /app/packages/addon/dist/index.js 2>&1 || echo 'NOT FOUND')"

exec node /app/packages/addon/dist/index.js
