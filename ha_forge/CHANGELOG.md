# Changelog

## 0.1.0

Initial release.

- Define HA entities in TypeScript with full type safety
- 28 supported entity types via MQTT discovery
- Auto-generated types from your HA instance (entities, services, helpers)
- Monaco editor with IntelliSense (web UI via ingress)
- Build pipeline: type generation, tsc checking, esbuild bundling
- Reactive patterns: `ha.on()`, `ha.callService()`, `reactions()`
- SQLite logging with web viewer
- Health entities for monitoring build status
- Scheduled type validation to detect HA registry drift
- MQTT reconnect with automatic re-discovery
