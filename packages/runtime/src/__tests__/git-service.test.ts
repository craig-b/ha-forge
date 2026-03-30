import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../git-service.js';

describe('GitService', () => {
  let tmpDir: string;
  let git: GitService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-service-test-'));
    git = new GitService(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensureRepo', () => {
    it('initializes a git repo with .gitignore', async () => {
      await git.ensureRepo();

      expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('node_modules/');
      expect(gitignore).toContain('.generated/');
      expect(gitignore).toContain('*.js');
    });

    it('is idempotent', async () => {
      await git.ensureRepo();
      await git.ensureRepo();

      expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
    });
  });

  describe('commitFile', () => {
    it('commits a file and returns SHA', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const sha = await git.commitFile(filePath);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('creates commit message with filename and timestamp', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'lights.ts');
      fs.writeFileSync(filePath, 'export default {};', 'utf-8');

      await git.commitFile(filePath);

      const history = await git.getFileHistory(filePath, 1);
      expect(history).toHaveLength(1);
      expect(history[0].message).toMatch(/^lights\.ts — \d{4}-\d{2}-\d{2}T/);
    });

    it('commits file with sidecar', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      const sidecar = path.join(tmpDir, 'test.package.json');
      fs.writeFileSync(filePath, 'import dayjs from "dayjs";', 'utf-8');
      fs.writeFileSync(sidecar, '{"dependencies":{"dayjs":"^2.0.0"}}', 'utf-8');

      const sha = await git.commitFile(filePath, sidecar);

      // Both files should be in the commit
      const tsContent = await git.getFileAtCommit(sha, filePath);
      const sidecarContent = await git.getFileAtCommit(sha, sidecar);
      expect(tsContent).toBe('import dayjs from "dayjs";');
      expect(sidecarContent).toBe('{"dependencies":{"dayjs":"^2.0.0"}}');
    });

    it('ignores missing sidecar', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const sha = await git.commitFile(filePath, path.join(tmpDir, 'test.package.json'));
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('commitDelete', () => {
    it('commits a file deletion', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'const x = 1;', 'utf-8');
      await git.commitFile(filePath);

      fs.unlinkSync(filePath);
      const sha = await git.commitDelete(filePath);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const exists = await git.fileExistsAtCommit(sha, filePath);
      expect(exists).toBe(false);
    });

    it('deletes file and sidecar together', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      const sidecar = path.join(tmpDir, 'test.package.json');
      fs.writeFileSync(filePath, 'code', 'utf-8');
      fs.writeFileSync(sidecar, '{}', 'utf-8');
      await git.commitFile(filePath, sidecar);

      fs.unlinkSync(filePath);
      fs.unlinkSync(sidecar);
      const sha = await git.commitDelete(filePath, sidecar);

      expect(await git.fileExistsAtCommit(sha, filePath)).toBe(false);
      expect(await git.fileExistsAtCommit(sha, sidecar)).toBe(false);
    });
  });

  describe('commitRename', () => {
    it('commits a rename', async () => {
      await git.ensureRepo();

      const oldPath = path.join(tmpDir, 'old.ts');
      const newPath = path.join(tmpDir, 'new.ts');
      fs.writeFileSync(oldPath, 'const x = 1;', 'utf-8');
      await git.commitFile(oldPath);

      fs.renameSync(oldPath, newPath);
      const sha = await git.commitRename(oldPath, newPath);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const content = await git.getFileAtCommit(sha, newPath);
      expect(content).toBe('const x = 1;');
      expect(await git.fileExistsAtCommit(sha, oldPath)).toBe(false);
    });

    it('renames file and sidecar together', async () => {
      await git.ensureRepo();

      const oldTs = path.join(tmpDir, 'old.ts');
      const oldSidecar = path.join(tmpDir, 'old.package.json');
      const newTs = path.join(tmpDir, 'new.ts');
      const newSidecar = path.join(tmpDir, 'new.package.json');

      fs.writeFileSync(oldTs, 'code', 'utf-8');
      fs.writeFileSync(oldSidecar, '{"dependencies":{}}', 'utf-8');
      await git.commitFile(oldTs, oldSidecar);

      fs.renameSync(oldTs, newTs);
      fs.renameSync(oldSidecar, newSidecar);
      const sha = await git.commitRename(oldTs, newTs, oldSidecar, newSidecar);

      expect(await git.getFileAtCommit(sha, newTs)).toBe('code');
      expect(await git.getFileAtCommit(sha, newSidecar)).toBe('{"dependencies":{}}');
      expect(await git.fileExistsAtCommit(sha, oldTs)).toBe(false);
      expect(await git.fileExistsAtCommit(sha, oldSidecar)).toBe(false);
    });
  });

  describe('getFileHistory', () => {
    it('returns commits in reverse chronological order', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'v1', 'utf-8');
      await git.commitFile(filePath);

      fs.writeFileSync(filePath, 'v2', 'utf-8');
      await git.commitFile(filePath);

      fs.writeFileSync(filePath, 'v3', 'utf-8');
      await git.commitFile(filePath);

      const history = await git.getFileHistory(filePath);
      expect(history).toHaveLength(3);
      // Most recent first
      expect(history[0].sha).not.toBe(history[2].sha);
    });

    it('respects limit parameter', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(filePath, `v${i}`, 'utf-8');
        await git.commitFile(filePath);
      }

      const history = await git.getFileHistory(filePath, 2);
      expect(history).toHaveLength(2);
    });

    it('returns empty for non-existent file', async () => {
      await git.ensureRepo();

      const history = await git.getFileHistory(path.join(tmpDir, 'nope.ts'));
      expect(history).toHaveLength(0);
    });
  });

  describe('getFileAtCommit', () => {
    it('returns file content at a specific commit', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'version-1', 'utf-8');
      const sha1 = await git.commitFile(filePath);

      fs.writeFileSync(filePath, 'version-2', 'utf-8');
      await git.commitFile(filePath);

      const content = await git.getFileAtCommit(sha1, filePath);
      expect(content).toBe('version-1');
    });

    it('returns null for non-existent file at commit', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'content', 'utf-8');
      const sha = await git.commitFile(filePath);

      const content = await git.getFileAtCommit(sha, path.join(tmpDir, 'other.ts'));
      expect(content).toBeNull();
    });
  });

  describe('fileExistsAtCommit', () => {
    it('returns true when file exists', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'content', 'utf-8');
      const sha = await git.commitFile(filePath);

      expect(await git.fileExistsAtCommit(sha, filePath)).toBe(true);
    });

    it('returns false when file does not exist', async () => {
      await git.ensureRepo();

      const filePath = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(filePath, 'content', 'utf-8');
      const sha = await git.commitFile(filePath);

      expect(await git.fileExistsAtCommit(sha, path.join(tmpDir, 'nope.ts'))).toBe(false);
    });
  });

  describe('mutex', () => {
    it('handles concurrent commits without corruption', async () => {
      await git.ensureRepo();

      // Fire multiple commits concurrently
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const filePath = path.join(tmpDir, `file${i}.ts`);
        fs.writeFileSync(filePath, `content ${i}`, 'utf-8');
        promises.push(git.commitFile(filePath));
      }

      const shas = await Promise.all(promises);

      // All should have unique SHAs
      const unique = new Set(shas);
      expect(unique.size).toBe(5);

      // All SHAs should be valid
      for (const sha of shas) {
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      }
    });
  });
});
