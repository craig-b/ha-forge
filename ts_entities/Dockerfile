ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_VERSION
FROM ${BUILD_FROM}

# Install Node.js and build tools for native modules (better-sqlite3)
RUN apk add --no-cache nodejs npm python3 make g++

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Clone and build the project
RUN apk add --no-cache git && \
    git clone --depth 1 --branch "v${BUILD_VERSION}" \
      https://github.com/craig-b/ha-ts-entities.git /tmp/src || \
    git clone --depth 1 https://github.com/craig-b/ha-ts-entities.git /tmp/src

WORKDIR /tmp/src

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm build

# Move built artifacts to /app
WORKDIR /app
RUN cp /tmp/src/package.json /tmp/src/pnpm-lock.yaml /tmp/src/pnpm-workspace.yaml ./ && \
    mkdir -p packages/sdk packages/runtime packages/build packages/web packages/addon && \
    cp /tmp/src/packages/sdk/package.json packages/sdk/ && \
    cp /tmp/src/packages/runtime/package.json packages/runtime/ && \
    cp /tmp/src/packages/build/package.json packages/build/ && \
    cp /tmp/src/packages/web/package.json packages/web/ && \
    cp /tmp/src/packages/addon/package.json packages/addon/ && \
    cp -r /tmp/src/packages/sdk/dist packages/sdk/ && \
    cp -r /tmp/src/packages/runtime/dist packages/runtime/ && \
    cp -r /tmp/src/packages/build/dist packages/build/ && \
    cp -r /tmp/src/packages/web/dist packages/web/ && \
    cp -r /tmp/src/packages/addon/dist packages/addon/ && \
    cp /tmp/src/packages/addon/run.sh ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Clean up build artifacts and tools
RUN rm -rf /tmp/src && \
    apk del git python3 make g++

# Ensure persistent directories exist
RUN mkdir -p /data /config

# Make run script executable
RUN chmod a+x /app/run.sh

CMD [ "/app/run.sh" ]
