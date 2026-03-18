# Build Pipeline

The build pipeline transforms user TypeScript files into deployable JavaScript bundles. It is an explicit, discrete step — the user clicks Build in the Monaco panel (or enables opt-in auto-build on save). This avoids ambiguity around npm install timing and partial saves.

## Pipeline Steps

```
1. Type Generation    →  HA WebSocket API → .d.ts + validators
2. Dependency Install →  npm install (if package.json changed)
3. Type Check         →  tsc --noEmit → diagnostics for Monaco
4. Bundle             →  esbuild → self-contained JS per file
5. Deploy             →  teardown old → load new → register → init
```

## Step 1: Type Generation

### Data Sources

The type generator connects to HA's WebSocket API and pulls six datasets:

| WebSocket Command | What It Provides |
|---|---|
| `get_services` | Every service per domain, with `fields` containing `selector` definitions (type, min/max, options, required, default). Richest source for typed parameters. |
| `get_states` | Every entity's current state and attributes. Used to infer attribute shapes. |
| `config/entity_registry/list` | Entity IDs, domains, device associations, categories, areas. |
| `config/device_registry/list` | Device info: manufacturer, model, area assignments. |
| `config/area_registry/list` | Area IDs and names. |
| `config/label_registry/list` | Label IDs and names. |

### Selector-to-Type Mapping

Each service field in the `get_services` response includes a `selector` that maps to a TypeScript type:

| Selector | TypeScript Type | Runtime Validator |
|---|---|---|
| `number: { min: 0, max: 255 }` | `NumberInRange<0, 255>` | `rangeValidator(0, 255)` |
| `boolean` | `boolean` | — |
| `text` | `string` | — |
| `select: { options: ['a', 'b'] }` | `'a' \| 'b'` | `oneOfValidator(['a', 'b'])` |
| `entity: { domain: 'light' }` | Entity ID union filtered to lights | `entityExistsValidator('light')` |
| `color_rgb` | `[number, number, number]` | `rgbValidator()` |
| `color_temp` | `NumberInRange<min_mireds, max_mireds>` | `rangeValidator(min, max)` |
| `time` | `string` | `timeFormatValidator()` |
| `time_period` | `string` | `timePeriodValidator()` |
| `template` | `string` | — |
| `device` | Device ID string | `deviceExistsValidator()` |
| `area` | Area ID string | `areaExistsValidator()` |
| `object` | `Record<string, unknown>` | — |

Fields marked `required: true` become non-optional in the generated type. Fields with `default` values are optional. Unknown selector types added in future HA versions fall back to `unknown` safely.

### Output: Type Declaration File

Written to `/config/.generated/ha-registry.d.ts`:

```typescript
export type HAEntityMap = {
  'light.living_room': {
    domain: 'light';
    state: 'on' | 'off';
    attributes: {
      brightness: NumberInRange<0, 255>;
      color_temp: NumberInRange<153, 500>;
      rgb_color: [number, number, number];
      friendly_name: string;
    };
    services: {
      turn_on: {
        brightness?: NumberInRange<0, 255>;
        color_temp?: NumberInRange<153, 500>;
        rgb_color?: [number, number, number];
        transition?: NumberInRange<0, 300>;
        flash?: 'short' | 'long';
        effect?: string;
      };
      turn_off: { transition?: NumberInRange<0, 300> };
      toggle: {};
    };
  };
  'input_select.house_mode': {
    domain: 'input_select';
    state: 'home' | 'away' | 'sleeping' | 'vacation';
    attributes: { options: string[]; friendly_name: string };
    services: {
      select_option: { option: 'home' | 'away' | 'sleeping' | 'vacation' };
      select_next: {};
      select_previous: {};
    };
  };
  // ... every entity in the HA installation
};

export type HAEntityId = keyof HAEntityMap;
export type HADomain = HAEntityMap[HAEntityId]['domain'];
export type EntitiesInDomain<D extends HADomain> = {
  [K in HAEntityId]: HAEntityMap[K]['domain'] extends D ? K : never;
}[HAEntityId];
```

### Output: Runtime Validator Module

Written to `/config/.generated/ha-validators.ts`:

```typescript
import { rangeValidator, oneOfValidator, rgbValidator } from 'ts-entities/validate';

export const validators = {
  'light.turn_on': {
    brightness: rangeValidator(0, 255),
    color_temp: rangeValidator(153, 500),
    transition: rangeValidator(0, 300),
    flash: oneOfValidator(['short', 'long'] as const),
  },
  'input_select.house_mode': {
    option: oneOfValidator(['home', 'away', 'sleeping', 'vacation'] as const),
  },
  'input_number.target_temperature': {
    value: rangeValidator(7, 35),
  },
} as const;
```

Types and validators are generated from the same selector metadata, so they are always in sync.

### Generated File Location

All generated files go to `/config/.generated/`:

```
/config/.generated/
├── ha-registry.d.ts      # Type declarations
├── ha-validators.ts       # Runtime validator module
└── ha-registry-meta.json  # Metadata: generation timestamp, entity count, HA version
```

The `.generated/` directory is excluded from user editing in the Monaco file tree and from version control.

## Step 2: Dependency Install

If `package.json` has changed since the last build (tracked by hash comparison), run `npm install` in the scripts directory. This happens before compilation so that esbuild can resolve third-party imports.

The Monaco panel provides a UI for searching npm packages and adding/removing them. Adding a package updates `package.json` and flags that install is needed on next build. Dependency changes always require an explicit build — file watching does not trigger `npm install`.

After install, the pipeline scans `node_modules/` for `.d.ts` files to inject into Monaco via `addExtraLib()` for third-party package IntelliSense.

## Step 3: Type Check

Run `tsc --noEmit` against user scripts with the generated types. This is a diagnostic-only step — it does not produce output.

Errors are:
- Displayed as squiggles in the Monaco editor.
- Listed in the build output console with file, line, column, and message.
- Logged to SQLite with `source_file: '_runtime'`.

Type errors **warn but do not block the build**. The user may have errors in files they're not currently using. The build proceeds to bundling regardless.

### tsconfig.json

Scaffolded on first run if absent:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "paths": {
      "ts-entities": ["./.generated/ts-entities.d.ts"],
      "ts-entities/*": ["./.generated/ts-entities/*.d.ts"]
    }
  },
  "include": ["*.ts", ".generated/**/*.d.ts"]
}
```

## Step 4: Bundle

esbuild bundles each user `.ts` file with its dependencies into a self-contained JS file in a staging directory.

### Why Per-File Bundling

Each user file is an independent entry point. A file that fails to compile doesn't prevent other files from loading. This matches the mental model of "each file is a set of entities" and simplifies the deploy step.

### esbuild Configuration

```typescript
{
  entryPoints: userTsFiles,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: stagingDir,
  external: ['ts-entities'],  // provided by runtime
  sourcemap: true,
}
```

The `ts-entities` module is external — it's provided by the runtime, not bundled into user code. Everything else (user imports, npm dependencies) is bundled.

### Performance

esbuild is fast enough (sub-second on most hardware, including Raspberry Pi 4) that per-file bundling adds negligible overhead. If build times become a problem on very large script sets, incremental builds are possible but deferred.

## Step 5: Deploy

Deploy is the transition from one set of running entities to another.

### Sequence

1. **Teardown**: For each currently running entity:
   - Call user-defined `destroy()` callback (if present).
   - Force-dispose all tracked handles (timers, polls, subscriptions) not already cleaned up.
   - For removed entities (present in old build, absent in new): publish empty retained payload to MQTT discovery topic to deregister from HA.
2. **Load**: Import bundled JS files from staging directory.
3. **Register**: For each entity definition in the new build:
   - Resolve transport (MQTT for v1).
   - Publish MQTT device discovery payload.
   - Subscribe to command topics for bidirectional entities.
4. **Init**: Call user-defined `init()` on each entity. If `init()` returns a value, publish it as initial state. If `init()` throws, log the error, skip the entity, continue with others.
5. **State**: Publish initial state for all successfully initialized entities.

### Atomicity

The deploy is all-or-nothing at the file level. If a file's bundle fails to load, none of its entities register, but entities from other files are unaffected. If an entity's `init()` throws, that entity is skipped but others in the same file still load.

## Scheduled Validation

Separate from the build pipeline. Detects when HA registry changes break existing scripts.

### Trigger

- Configurable schedule (default: hourly).
- Optionally on HA entity registry change events.

### Process

1. Pull current entity registry from HA WebSocket API.
2. Regenerate types into a **temporary directory** (does not touch live types).
3. Run `tsc --noEmit` against user scripts with the new types.
4. Collect errors.
5. Update health entities (see [infrastructure.md](infrastructure.md#health-entities)).

The running instance is never modified. This is a read-only check.

### What Triggers Errors

- An entity ID referenced in user code was renamed or deleted from HA.
- A helper's configured options changed (e.g., an `input_select` option removed that user code matches against).
- An entity's domain changed.
- An attribute a script depends on is no longer present.

### Auto-Rebuild (Optional)

Configurable behavior when scheduled validation **passes** with new types:
- **Manual** (default): just update health entities. User rebuilds when ready.
- **Auto-rebuild**: trigger a full build and deploy with the updated types. If validation fails, keep the old build running and flip health entity to unhealthy.
