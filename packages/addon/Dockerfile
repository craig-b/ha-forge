ARG BUILD_FROM=node:20-alpine
ARG BUILD_VERSION=dev
FROM ${BUILD_FROM}

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/runtime/package.json packages/runtime/
COPY packages/build/package.json packages/build/
COPY packages/web/package.json packages/web/
COPY packages/addon/package.json packages/addon/

# Install pnpm and dependencies
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile --prod

# Copy built application code
COPY packages/sdk/dist/ packages/sdk/dist/
COPY packages/runtime/dist/ packages/runtime/dist/
COPY packages/build/dist/ packages/build/dist/
COPY packages/web/dist/ packages/web/dist/
COPY packages/addon/dist/ packages/addon/dist/

# Copy addon config
COPY packages/addon/config.yaml /app/
COPY packages/addon/run.sh /app/

# Make run script executable
RUN chmod a+x /app/run.sh

# Remove build dependencies to shrink image
RUN apk del python3 make g++

# Ensure /data and /config directories exist
RUN mkdir -p /data /config

# Labels for HA add-on
LABEL \
  io.hass.name="HA Forge" \
  io.hass.description="Define Home Assistant entities in TypeScript" \
  io.hass.type="addon" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.arch="amd64|aarch64|armv7"

CMD [ "/app/run.sh" ]
