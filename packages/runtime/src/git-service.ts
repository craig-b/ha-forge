import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CommitInfo {
  sha: string;
  timestamp: string;
  message: string;
}

const GITIGNORE_CONTENT = `node_modules/
.generated/
*.js
*.js.map
`;

/**
 * Wraps git operations for the user scripts repository.
 * All operations use execFile (array args, no shell) to prevent injection.
 * An async mutex serializes operations that touch the git index.
 */
export class GitService {
  private repoDir: string;
  private mutex: Promise<void> = Promise.resolve();

  constructor(repoDir: string) {
    this.repoDir = repoDir;
  }

  /** Initialize a git repo if one doesn't exist, and write .gitignore. */
  async ensureRepo(): Promise<void> {
    return this.withMutex(async () => {
      const gitDir = path.join(this.repoDir, '.git');
      if (!fs.existsSync(gitDir)) {
        await this.gitExec(['init']);
        // Configure user for commits (required in containers without global config)
        await this.gitExec(['config', 'user.email', 'ha-forge@local']);
        await this.gitExec(['config', 'user.name', 'HA Forge']);
      }

      const gitignorePath = path.join(this.repoDir, '.gitignore');
      const needsWrite = !fs.existsSync(gitignorePath) ||
        fs.readFileSync(gitignorePath, 'utf-8') !== GITIGNORE_CONTENT;
      if (needsWrite) {
        fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
        await this.gitExec(['add', '.gitignore']);
        // Only commit if there are staged changes
        const status = await this.gitExec(['status', '--porcelain']);
        if (status.trim()) {
          await this.gitExec(['commit', '-m', '.gitignore']);
        }
      }
    });
  }

  /**
   * Stage multiple files and commit them in a single commit.
   * Returns the commit SHA.
   */
  async commitAll(files: string[], message: string): Promise<string> {
    return this.withMutex(async () => {
      for (const file of files) {
        const relFile = path.relative(this.repoDir, file);
        await this.gitExec(['add', relFile]);
      }
      await this.gitExec(['commit', '-m', message]);
      return this.getHeadSha();
    });
  }

  /**
   * Stage and commit a file (and optional sidecar).
   * Commit message: `<filename> — <ISO timestamp>`
   * Returns the commit SHA.
   */
  async commitFile(file: string, sidecar?: string): Promise<string> {
    return this.withMutex(async () => {
      const relFile = path.relative(this.repoDir, file);
      await this.gitExec(['add', relFile]);
      if (sidecar) {
        const relSidecar = path.relative(this.repoDir, sidecar);
        if (fs.existsSync(sidecar)) {
          await this.gitExec(['add', relSidecar]);
        }
      }
      // Skip commit if nothing staged (e.g. file saved without changes)
      const status = await this.gitExec(['status', '--porcelain']);
      if (!status.trim()) {
        return this.getHeadSha();
      }
      const timestamp = new Date().toISOString();
      const basename = path.basename(relFile);
      await this.gitExec(['commit', '-m', `${basename} — ${timestamp}`]);
      return this.getHeadSha();
    });
  }

  /**
   * Stage deletion and commit.
   * Returns the commit SHA.
   */
  async commitDelete(file: string, sidecar?: string): Promise<string> {
    return this.withMutex(async () => {
      const relFile = path.relative(this.repoDir, file);
      await this.gitExec(['rm', '--cached', '--ignore-unmatch', relFile]);
      if (sidecar) {
        const relSidecar = path.relative(this.repoDir, sidecar);
        await this.gitExec(['rm', '--cached', '--ignore-unmatch', relSidecar]);
      }
      const timestamp = new Date().toISOString();
      const basename = path.basename(relFile);
      await this.gitExec(['commit', '-m', `delete ${basename} — ${timestamp}`, '--allow-empty']);
      return this.getHeadSha();
    });
  }

  /**
   * Stage rename (old removal + new addition) and commit.
   * Returns the commit SHA.
   */
  async commitRename(
    oldFile: string,
    newFile: string,
    oldSidecar?: string,
    newSidecar?: string,
  ): Promise<string> {
    return this.withMutex(async () => {
      const relOld = path.relative(this.repoDir, oldFile);
      const relNew = path.relative(this.repoDir, newFile);
      // Stage removal of old and addition of new
      await this.gitExec(['rm', '--cached', '--ignore-unmatch', relOld]);
      await this.gitExec(['add', relNew]);
      if (oldSidecar) {
        const relOldSidecar = path.relative(this.repoDir, oldSidecar);
        await this.gitExec(['rm', '--cached', '--ignore-unmatch', relOldSidecar]);
      }
      if (newSidecar && fs.existsSync(newSidecar)) {
        const relNewSidecar = path.relative(this.repoDir, newSidecar);
        await this.gitExec(['add', relNewSidecar]);
      }
      const timestamp = new Date().toISOString();
      const oldBase = path.basename(relOld);
      const newBase = path.basename(relNew);
      await this.gitExec(['commit', '-m', `rename ${oldBase} → ${newBase} — ${timestamp}`]);
      return this.getHeadSha();
    });
  }

  /**
   * Get commit history for a file.
   * Uses --follow to track renames.
   */
  async getFileHistory(file: string, limit = 50): Promise<CommitInfo[]> {
    const relFile = path.relative(this.repoDir, file);
    const format = '%H%n%aI%n%s%n---';
    const output = await this.gitExec([
      'log', '--follow', `--format=${format}`, `-n`, String(limit), '--', relFile,
    ]);
    return this.parseLogOutput(output);
  }

  /**
   * Get file content at a specific commit.
   * Returns null if the file doesn't exist at that commit.
   */
  async getFileAtCommit(sha: string, file: string): Promise<string | null> {
    const relFile = path.relative(this.repoDir, file);
    try {
      return await this.gitExec(['show', `${sha}:${relFile}`]);
    } catch {
      return null;
    }
  }

  /** Check if a file exists at a specific commit. */
  async fileExistsAtCommit(sha: string, file: string): Promise<boolean> {
    const relFile = path.relative(this.repoDir, file);
    try {
      await this.gitExec(['cat-file', '-e', `${sha}:${relFile}`]);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Internal ----

  private async getHeadSha(): Promise<string> {
    const sha = await this.gitExec(['rev-parse', 'HEAD']);
    return sha.trim();
  }

  private parseLogOutput(output: string): CommitInfo[] {
    if (!output.trim()) return [];
    const entries = output.trim().split('\n---\n');
    const results: CommitInfo[] = [];
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n');
      if (lines.length >= 3) {
        results.push({
          sha: lines[0],
          timestamp: lines[1],
          message: lines.slice(2).join('\n'),
        });
      }
    }
    return results;
  }

  /** Runs git with array-based args via execFile (no shell, prevents injection). */
  private gitExec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: this.repoDir, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /**
   * Serialize index-mutating operations to prevent concurrent access.
   * Read-only operations (log, show, cat-file) don't need the mutex,
   * but commit/add/rm do.
   */
  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let resolve: () => void;
    this.mutex = new Promise<void>((r) => { resolve = r; });
    return prev.then(fn).finally(() => resolve!());
  }
}
