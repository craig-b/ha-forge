# Architecture Overview

## System Context

HA Forge runs as a Home Assistant add-on — a Docker container managed by the HA Supervisor on HAOS. It connects to two HA subsystems: the MQTT broker (Mosquitto add-on) for entity registration and state traffic, and the HA WebSocket API for registry introspection, state subscriptions, and service calls.

```
┌─────────────────────────────────────────────────────────────────┐
│  Home Assistant OS                                              │
│                                                                 │
│  ┌──────────────────────┐       ┌───────────────────────────┐  │
│  │  HA Core             │       │  Mosquitto (MQTT Broker)  │  │
│  │                      │       │                           │  │
│  │  - Entity registry   │       │  - Discovery topics       │  │
│  │  - State machine     │       │  - State topics           │  │
│  │  - Service registry  │       │  - Command topics         │  │
│  │  - Event bus         │       │  - Availability / LWT     │  │
│  │  - WebSocket API     │       │                           │  │
│  └──────────┬───────────┘       └─────────┬─────────────────┘  │
│             │ ws://supervisor/              │ mqtt://            │
│             │ core/websocket               │                    │
│  ┌──────────┴──────────────────────────────┴─────────────────┐  │
│  │  HA Forge Add-on (Docker)                              │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌─────────┐  ┌──────────────────────┐  │  │
│  │  │  Build       │  │ Runtime │  │  Web UI (Ingress)    │  │  │
│  │  │  Pipeline    │  │         │  │                      │  │  │
│  │  │             │  │         │  │  Monaco + Dashboard   │  │  │
│  │  │  TypeGen     │  │ Entity  │  │  + Log Viewer        │  │  │
│  │  │  esbuild     │  │ Lifecy. │  │                      │  │  │
│  │  │  tsc         │  │ Transp. │  │  :8099 (ingress)     │  │  │
│  │  └─────────────┘  └─────────┘  └──────────────────────┘  │  │
│  │                                                           │  │
│  │  /config/  ←─ addon_config mapping (user scripts + pkg)   │  │
│  │  /data/    ←─ persistent storage (logs, build cache)      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────┐                                      │
│  │  HA Supervisor        │                                      │
│  │  - Add-on management  │                                      │
│  │  - MQTT credentials   │                                      │
│  │  - Ingress gateway    │                                      │
│  │  - SUPERVISOR_TOKEN   │                                      │
│  └───────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Build Pipeline

Transforms user TypeScript into deployable JavaScript. Explicit, discrete step — not implicit file watching (opt-in auto-build available).

**Modules:** Type generator, dependency manager, compiler (esbuild), type checker (tsc), deployer.

**Inputs:** User `.ts` files, HA WebSocket API (entity registry, service definitions, state data).

**Outputs:** Bundled JS in staging directory, `.d.ts` type declarations, runtime validator module, tsc diagnostics.

See [build-pipeline.md](build-pipeline.md).

### 2. Runtime

Manages entity lifecycle and all communication with HA and MQTT. Loads bundled output from the build pipeline, registers entities, handles state updates and commands, and tears everything down on redeploy or shutdown.

**Modules:** Entity lifecycle manager, transport router, MQTT transport, HA WebSocket client, reactive system, entity context provider.

**Inputs:** Bundled JS from build pipeline, MQTT messages (commands), WebSocket events (state changes).

**Outputs:** MQTT messages (discovery, state, availability), WebSocket messages (service calls, event subscriptions).

See [runtime.md](runtime.md).

### 3. SDK

The TypeScript API that user scripts import. Provides typed entity definition functions, the `ha.*` API for interacting with Home Assistant, and the generated type registry that makes everything type-safe.

**Modules:** Type system (NumberInRange, HAEntityMap, etc.), entity definition API (24 platform factories + automation, computed, cron, mode, task, device, entityFactory), ha.* API, this.events reactive API, runtime validators, composable behaviors (debounced, filtered, sampled, buffered).

**Inputs:** Generated type registry from build pipeline.

**Outputs:** Entity definitions consumed by the runtime.

See [sdk.md](sdk.md).

### 4. Web UI

Ingress-based panel accessible from the HA sidebar. Monaco editor with full IntelliSense, entity dashboard, log viewer, build controls, and dependency management.

**Modules:** Monaco editor + type injection, file tree, build console, entity dashboard, log viewer, REST + WebSocket API server.

**Inputs:** User interactions, build results, entity state, log entries.

**Outputs:** File changes, build triggers, dependency changes.

See [web-ui.md](web-ui.md).

### 5. Infrastructure

The add-on container, persistent storage, MQTT connection management, SQLite logging, health entities, and backup integration.

**Modules:** Add-on container (Dockerfile, config.yaml), MQTT connection manager, SQLite logger, health entity publisher, supervisor API client.

See [infrastructure.md](infrastructure.md).

## Data Flows

### Build Flow

```
User clicks Build (or auto-build on save)
  → Type generator connects to HA WebSocket API
    → get_services, get_states, config/entity_registry/list,
      config/device_registry/list, config/area_registry/list,
      config/label_registry/list
    → Generates .generated/ha-registry.d.ts (types)
    → Generates .generated/ha-validators.ts (runtime validators)
  → npm install (if package.json changed since last build)
  → tsc --noEmit (diagnostics only, displayed in Monaco)
  → esbuild bundles each .ts file → staging directory
  → Deploy: teardown old → load new → register → init → publish state
```

### Entity Registration Flow (MQTT Device Discovery)

```
Runtime resolves entity → MQTT transport
  → Publish retained JSON to homeassistant/device/<device_id>/config
    {
      dev: { ids, name, manufacturer, model, sw },
      o: { name: "ha-forge", sw: "<version>", url: "<repo>" },
      cmps: {
        <entity_key>: { p: "<platform>", unique_id, stat_t, cmd_t, ... }
      },
      avty_t: "ha-forge/availability",
    }
  → HA picks up entities from discovery topic
  → Publish initial state to each entity's state topic
```

### State Update Flow

```
User code calls this.update(value, attributes)
  → Runtime serializes state
  → MQTT transport publishes to entity's state topic
  → HA state machine updates
  → HA UI reflects new state
```

### Command Flow (Bidirectional Entities)

```
User interacts with entity in HA UI (e.g., toggles switch)
  → HA publishes command to entity's MQTT command topic
  → MQTT transport receives message
  → Runtime dispatches to entity's onCommand() callback
  → User code handles command, optionally calls this.update()
```

### HA Subscription Flow

```
User code calls ha.on('light.living_room', callback)
  → Runtime subscribes to state_changed events via HA WebSocket
  → HA state machine fires event on entity change
  → WebSocket delivers event to runtime
  → Runtime dispatches typed event to user callback
```

### Service Call Flow

```
User code calls ha.callService('light.living_room', 'turn_on', { brightness: 200 })
  → Runtime validates parameters against generated validators
    → If validation fails: throw with descriptive error, log to SQLite, do not dispatch
  → Runtime sends call_service via HA WebSocket
    → { type: "call_service", domain: "light", service: "turn_on",
        service_data: { brightness: 200 }, target: { entity_id: "light.living_room" } }
  → HA executes service
```

## Key Design Decisions

### Why MQTT for Entity Registration

MQTT discovery is Home Assistant's established protocol for external entity registration. It supports 26+ entity types, handles availability natively via LWT, and requires no custom integration on the HA side. The add-on stays a pure add-on — no `custom_components/` needed for v1.

The tradeoff: a few entity types (media_player, calendar, weather) aren't supported by MQTT discovery. These are deferred to a future native bridge transport. The transport-agnostic API means user code won't change when this is added.

### Why esbuild + tsc (Not Just tsc)

esbuild handles compilation and bundling. It's sub-second on most hardware and produces self-contained output with no runtime module resolution. tsc runs separately in `--noEmit` mode purely for diagnostics. This gives fast builds and full type checking without either tool's weaknesses.

### Why No Sandboxing Beyond the Container

User scripts run in Node.js inside the add-on container. No V8 isolates, no vm2, no worker thread isolation (v1). This matches the security model of Node-RED and AppDaemon — the user is the script author, and HAOS add-ons are already containerized with scoped filesystem and network access.

### Why addon_config Instead of homeassistant_config

The HA Supervisor provides two filesystem mapping options. `homeassistant_config` gives access to HA's entire `/config/` directory. `addon_config` gives the add-on its own isolated directory at `/addon_configs/{slug}/`, automatically included in HA backups. We use `addon_config` to avoid mixing user scripts with HA's configuration files and to get backup integration for free.

### Why Device Discovery Over Single-Component Discovery

HA's newer device discovery pattern (`homeassistant/device/<id>/config`) groups multiple entities under a single device in one MQTT message. This is a better fit than single-component discovery because user files naturally produce groups of related entities, it reduces MQTT traffic, and it's the recommended approach going forward. Single-component discovery is still available as a fallback for standalone entities.
