#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: scripts/release.sh <version> (e.g. 0.2.0)}"

# Strip leading 'v' if provided
VERSION="${VERSION#v}"

echo "Releasing v${VERSION}..."

# Bump version in add-on config files
sed -i "s/^version: .*/version: ${VERSION}/" ts_entities/config.yaml
sed -i "s/^  BUILD_VERSION: .*/  BUILD_VERSION: \"${VERSION}\"/" ts_entities/build.yaml

# Commit, tag, push
git add ts_entities/config.yaml ts_entities/build.yaml
git commit -m "Release v${VERSION}"
git tag "v${VERSION}"
git push origin main "v${VERSION}"

echo "Done. v${VERSION} tagged and pushed — CI will build and publish Docker images."
