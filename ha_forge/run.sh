#!/usr/bin/env sh
set -e

echo "Starting HA Forge add-on..."

# The addon entry point runs the runtime which:
# 1. Reads options from /data/options.json
# 2. Connects to MQTT (credentials from supervisor API)
# 3. Connects to HA WebSocket API
# 4. Starts the web server on ingress port
# 5. Loads the last successful build if available
exec node /app/packages/addon/dist/index.js
