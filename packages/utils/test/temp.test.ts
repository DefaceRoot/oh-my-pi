import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "../src/temp";

describe("TempDir", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    // Clean up any dirs that weren't cleaned up in tests
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    createdDirs.length = 0;
  });

  describe("createSync", () => {
    test("creates temp directory with default prefix", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      expect(fs.existsSync(temp.path())).toBe(true);
      expect(temp.path()).toContain("pi-temp-");
    });

    test("creates temp directory with custom prefix", () => {
      const temp = TempDir.createSync("my-custom-prefix-");
      createdDirs.push(temp.path());

      expect(fs.existsSync(temp.path())).toBe(true);
      expect(temp.path()).toContain("my-custom-prefix-");
    });

    test("creates temp directory with @ prefix notation", () => {
      const temp = TempDir.createSync("@myapp-");
      createdDirs.push(temp.path());

      expect(fs.existsSync(temp.path())).toBe(true);
      expect(temp.path()).toContain("myapp-");
    });
  });

  describe("create", () => {
    test("async creates temp directory with default prefix", async () => {
      const temp = await TempDir.create();
      createdDirs.push(temp.path());

      expect(fs.existsSync(temp.path())).toBe(true);
      expect(temp.path()).toContain("pi-temp-");
    });

    test("async creates temp directory with custom prefix", async () => {
      const temp = await TempDir.create("async-prefix-");
      createdDirs.push(temp.path());

      expect(fs.existsSync(temp.path())).toBe(true);
      expect(temp.path()).toContain("async-prefix-");
    });
  });

  describe("path", () => {
    test("returns the directory path", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      const p = temp.path();
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
      expect(fs.existsSync(p)).toBe(true);
    });
  });

  describe("absolute", () => {
    test("returns absolute path", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      const abs = temp.absolute();
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs).toBe(path.resolve(temp.path()));
    });
  });

  describe("join", () => {
    test("joins single path with temp dir", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      const joined = temp.join("subdir");
      expect(joined).toBe(path.join(temp.path(), "subdir"));
    });

    test("joins multiple paths with temp dir", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      const joined = temp.join("a", "b", "c.txt");
      expect(joined).toBe(path.join(temp.path(), "a", "b", "c.txt"));
    });
  });

  describe("remove", () => {
    test("async removes directory", async () => {
      const temp = TempDir.createSync();
      const dirPath = temp.path();

      expect(fs.existsSync(dirPath)).toBe(true);

      await temp.remove();

      expect(fs.existsSync(dirPath)).toBe(false);
    });

    test("multiple remove() calls return same promise (dedup)", async () => {
      const temp = TempDir.createSync();
      const dirPath = temp.path();

      const promise1 = temp.remove();
      const promise2 = temp.remove();
      const promise3 = temp.remove();

      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      await promise1;

      expect(fs.existsSync(dirPath)).toBe(false);
    });
  });

  describe("removeSync", () => {
    test("sync removes directory", () => {
      const temp = TempDir.createSync();
      const dirPath = temp.path();

      expect(fs.existsSync(dirPath)).toBe(true);

      temp.removeSync();

      expect(fs.existsSync(dirPath)).toBe(false);
    });

    test("removeSync sets removePromise so subsequent remove() returns resolved promise", async () => {
      const temp = TempDir.createSync();
      const dirPath = temp.path();

      temp.removeSync();

      // After removeSync, remove() should return a resolved promise
      const promise = temp.remove();
      await promise;

      expect(fs.existsSync(dirPath)).toBe(false);
    });
  });

  describe("toString", () => {
    test("returns the path", () => {
      const temp = TempDir.createSync();
      createdDirs.push(temp.path());

      expect(temp.toString()).toBe(temp.path());
    });
  });

  describe("Symbol.asyncDispose", () => {
    test("auto-cleanup with await using", async () => {
      let dirPath: string;

      {
        await using temp = TempDir.createSync();
        dirPath = temp.path();
        expect(fs.existsSync(dirPath)).toBe(true);
      }

      // Directory should be cleaned up after scope exit
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    test("ignores cleanup errors", async () => {
      const temp = TempDir.createSync();
      const _dirPath = temp.path();

      // Remove it first
      await temp.remove();

      // Symbol.asyncDispose should not throw even if cleanup fails
      await expect(temp[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
  });

  describe("Symbol.dispose", () => {
    test("auto-cleanup with using", () => {
      let dirPath: string;

      {
        using temp = TempDir.createSync();
        dirPath = temp.path();
        expect(fs.existsSync(dirPath)).toBe(true);
      }

      // Directory should be cleaned up after scope exit
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    test("ignores cleanup errors", () => {
      const temp = TempDir.createSync();
      const _dirPath = temp.path();

      // Remove it first
      temp.removeSync();

      // Symbol.dispose should not throw even if cleanup fails
      expect(() => temp[Symbol.dispose]()).not.toThrow();
    });
  });
});
