ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

# Install build dependencies for native modules
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

# Remove build dependencies
RUN apk del python3 make g++

# Labels for HA add-on
LABEL \
  io.hass.name="TS Entities" \
  io.hass.description="Define Home Assistant entities in TypeScript" \
  io.hass.type="addon" \
  io.hass.version="0.1.0"

CMD [ "/app/run.sh" ]
