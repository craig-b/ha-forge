import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeployManifestEntry {
  commit: string;
  deployedAt: string;
  bundlePath: string;
}

export interface DeployManifest {
  files: Record<string, DeployManifestEntry>;
}

/**
 * Manages a persistent JSON file tracking which version of each script
 * is currently deployed. Uses atomic writes (write to .tmp, then rename)
 * to prevent corruption on crash.
 */
export class DeployManifestManager {
  private manifestPath: string;

  constructor(manifestPath: string) {
    this.manifestPath = manifestPath;
  }

  /** Read the manifest. Returns empty manifest if file doesn't exist. */
  read(): DeployManifest {
    try {
      const content = fs.readFileSync(this.manifestPath, 'utf-8');
      return JSON.parse(content) as DeployManifest;
    } catch {
      return { files: {} };
    }
  }

  /** Write the full manifest atomically. */
  write(manifest: DeployManifest): void {
    const dir = path.dirname(this.manifestPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.manifestPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.manifestPath);
  }

  /** Set or update a single file's deploy entry. */
  setFile(filename: string, entry: DeployManifestEntry): void {
    const manifest = this.read();
    manifest.files[filename] = entry;
    this.write(manifest);
  }

  /** Remove a file's deploy entry. */
  removeFile(filename: string): void {
    const manifest = this.read();
    delete manifest.files[filename];
    this.write(manifest);
  }

  /** Get a single file's deploy entry, or undefined if not deployed. */
  getFile(filename: string): DeployManifestEntry | undefined {
    const manifest = this.read();
    return manifest.files[filename];
  }
}
