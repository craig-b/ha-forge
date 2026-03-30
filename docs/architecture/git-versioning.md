# Git-Backed File Versioning & Deployment

## Overview

Each user script is an independent, self-contained unit — versioned individually via git, built independently, and deployed explicitly. Git provides the version history; a deploy manifest tracks which version of each file is currently running. There are no cross-file imports; each script declares its own npm dependencies via a sidecar package file.

---

## Principles

1. **Per-file independence.** Each `.ts` file is a standalone unit. No cross-file imports. No shared state between scripts at the source level.
2. **Save ≠ Deploy.** Saving commits the source to git. Deploying is a separate, explicit action on a specific committed version.
3. **Self-contained bundles.** The built `.js` bundle contains all npm dependencies inlined. Only the SDK runtime is external. A bundle can be deployed without access to `node_modules`.
4. **Deterministic deploys.** The deploy manifest records exactly which commit of each file is running. Restarts reproduce the same state.

---

## Git Layer

### Repository

A git repo is initialized in the scripts directory (`/config/`) if one does not already exist. This repo tracks only user scripts and their sidecar package files.

**.gitignore:**
```
node_modules/
.generated/
*.js
*.js.map
```

### Auto-Commit on Save

When a file is saved via the web UI:

1. Stage the saved file (and its sidecar `*.package.json` if it changed).
2. Commit with message: `<filename> — <ISO timestamp>`.
3. The commit is synchronous with the save response — the UI can immediately show the new version in history.

Example commit messages:
```
lights.ts — 2026-03-30T14:32:01Z
climate.ts — 2026-03-30T15:10:44Z
```

### File History

Git log filtered per file (`git log --follow -- <file>`) provides the version history. Each entry has:

- Commit SHA
- Timestamp
- Whether this commit is the currently deployed version (cross-referenced with the deploy manifest)

---

## Script Independence

### No Cross-File Imports

Relative imports between user scripts are not allowed. The build step enforces this — any `import` from a relative path (`./`, `../`) that resolves to another user script produces a build error:

> "Cross-file imports are not supported. Each script must be self-contained."

Imports from npm packages and the SDK (`@ha-forge/sdk`) remain valid.

### Per-File Package Sidecar

Each script may optionally have a sidecar file declaring its npm dependencies:

```
lights.ts
lights.package.json    ← optional, hidden in file browser
climate.ts
```

**`lights.package.json`:**
```json
{
  "dependencies": {
    "dayjs": "^2.0.0"
  }
}
```

- Standard `package.json` format (only `dependencies` field is relevant).
- Hidden in the web UI file browser — users manage dependencies through a dedicated UI panel.
- Created, deleted, and committed alongside the script automatically.
- Versioned in git together with the script — deploying an old commit of `lights.ts` uses the `lights.package.json` from that same commit.

---

## Package Management

### pnpm with Shared Store

Dependencies are managed by pnpm, using its content-addressable store for deduplication.

**Directory layout:**
```
/config/                  ← scripts directory (git repo, HA backup)
  lights.ts
  lights.package.json
  climate.ts
/data/                    ← add-on persistent storage (not backed up by HA)
  pnpm-store/             ← shared content-addressable package store
  node_modules/           ← shared node_modules for builds
```

- The pnpm store and `node_modules` live in `/data/`, not `/config/` — they are not included in HA backups (they can be reconstructed from the sidecar files).
- Before building a file, the build step ensures that file's declared dependencies are installed in the shared store.

### Type Injection

When a script has a sidecar package file, Monaco receives the corresponding `.d.ts` type definitions via `addExtraLib`. Types are scoped per editor model — only packages declared by the active script are available in autocomplete.

---

## Build Pipeline

The build pipeline is restructured into independent concerns:

### Type Generation (unchanged)

Fetches the HA entity registry via WebSocket and generates `.d.ts` types to `/config/.generated/`. Independent of file versioning — always reflects the current HA state.

### Build (per-file)

Builds a single script into a self-contained `.js` bundle:

1. Ensure declared dependencies are installed in the shared pnpm store.
2. Run esbuild with the script as the sole entry point.
3. All npm dependencies are bundled in (not external). Only `@ha-forge/sdk` remains external.
4. Output: a single `.js` file containing everything needed to run.

The build step can be triggered independently for validation (type-check + bundle without deploying).

### Type Check

`tsc --noEmit` runs against the working directory for editor diagnostics. This checks the current saved state of all files, not deployed versions. It is a development aid, not a deploy gate.

---

## Deploy Model

### Deploy Manifest

A persistent JSON file (stored in `/data/deploy-manifest.json`) tracks what is currently deployed:

```json
{
  "files": {
    "lights.ts": {
      "commit": "abc123def456",
      "deployedAt": "2026-03-30T14:35:00Z",
      "bundlePath": "/data/deployed-bundles/lights.js"
    },
    "climate.ts": {
      "commit": "789abc012def",
      "deployedAt": "2026-03-29T10:00:00Z",
      "bundlePath": "/data/deployed-bundles/climate.js"
    }
  }
}
```

### Deploy Flow

When a user deploys a specific version of a file:

1. **Extract** — `git show <commit>:<file>.ts` and `git show <commit>:<file>.package.json` (if it exists at that commit) into a temporary staging directory.
2. **Install** — Ensure the sidecar's dependencies are available in the shared pnpm store.
3. **Bundle** — esbuild bundles the staged `.ts` file, resolving npm imports from the shared `node_modules`. Output goes to `/data/deployed-bundles/<file>.js`.
4. **Teardown** — Tear down the currently running entities from that file (if any).
5. **Load** — Load the new bundle and deploy its entities.
6. **Update manifest** — Record the commit SHA, timestamp, and bundle path.
7. **Cleanup** — Remove the staging directory.

### Rollback

Rollback is just deploying a previous commit. The user selects an older version from the file history, clicks "Deploy this version", and the same deploy flow runs against that commit.

### Startup / Restart

On add-on startup:

1. Read the deploy manifest.
2. For each file in the manifest, load the bundle from `bundlePath`.
3. Deploy all entities.

No rebuild needed on restart — the pre-built bundles in `/data/deployed-bundles/` are used directly. This makes restarts fast and deterministic.

### Undeploy

To stop running a script's entities without deleting the file:

1. Tear down the file's entities.
2. Remove the file's entry from the deploy manifest.
3. Delete the bundle from `/data/deployed-bundles/`.

The source file and its git history are unaffected.

---

## Web UI

### File Browser

- Shows `.ts` files only — sidecar `*.package.json` files are hidden.
- Create/rename/delete operations handle the sidecar automatically (e.g., renaming `lights.ts` also renames `lights.package.json`).

### File History Panel

Per-file version list showing:

- Timestamp of each commit
- Deploy indicator — which version is currently deployed (green dot, "deployed" badge, etc.)
- "Deploy this version" action on each entry
- "View diff" action to compare any two versions

### Monaco Diff View

Side-by-side diff editor for comparing:

- Current working version vs. any historical commit
- Currently deployed version vs. latest saved version
- Any two commits in the file's history

### Dependencies Panel

When editing a script, a panel or button exposes dependency management:

- List installed packages (from the sidecar file)
- Add/remove packages (updates the sidecar, triggers pnpm install)
- Package search (npm registry)

### Deploy Status

Visible per-file indicator showing:

- **Not deployed** — file has never been deployed
- **Deployed (current)** — deployed version matches latest save
- **Deployed (behind)** — deployed version is older than latest save, with count of commits behind
- **Deployed (error)** — last deploy of this file failed

---

## Migration

For existing installations upgrading to git-backed versioning:

1. Initialize git repo in `/config/` if not present.
2. Commit all existing `.ts` files as the initial commit.
3. If a global `package.json` exists, generate per-file sidecar files by analyzing each script's actual imports.
4. Move `node_modules` from `/config/` to `/data/` and switch to pnpm.
5. Build and deploy all files, populating the deploy manifest.
6. The existing auto-build-on-save behavior continues to work but now triggers a commit + build (without auto-deploy).
