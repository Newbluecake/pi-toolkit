/** Tier 2: real bounded git, temporary repository only (no git add/commit). */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../../../src/git/run.js";
import { createPortRegistry } from "../../../src/reflex/ports/index.js";
import { env, deps } from "./helpers.js";

// A real v2 index and loose blob, assembled locally to obey the no-git-write rule.
// A tracked file with stale stat data makes an accidental index refresh observable.
function seedIndex(cwd: string): void {
  const path = "tracked file.txt";
  const content = Buffer.from("original\n");
  const blob = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]);
  const hash = createHash("sha1").update(blob).digest();
  const hex = hash.toString("hex");
  const objectDir = join(cwd, ".git", "objects", hex.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  writeFileSync(join(objectDir, hex.slice(2)), deflateSync(blob));
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const entry = Buffer.alloc(Math.ceil((62 + Buffer.byteLength(path) + 1) / 8) * 8);
  entry.writeUInt32BE(0o100644, 24);
  entry.writeUInt32BE(content.length, 36);
  hash.copy(entry, 40);
  entry.writeUInt16BE(Buffer.byteLength(path), 60);
  entry.write(path, 62);
  const index = Buffer.concat([header, entry]);
  writeFileSync(join(cwd, ".git", "index"), Buffer.concat([index, createHash("sha1").update(index).digest()]));
  writeFileSync(join(cwd, path), "modified\n");
}

describe("git.status real (Tier 2)", () => {
  it("reads actual staged/modified/untracked state without index changes or lock", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "reflex-git-"));
    try {
      execFileSync("git", ["init", "--initial-branch=reflex-test", "--object-format=sha1", cwd], {
        timeout: 5000,
        stdio: "pipe",
      });
      seedIndex(cwd);
      writeFileSync(join(cwd, "untracked file.txt"), "new\n");
      const index = join(cwd, ".git", "index");
      const before = statSync(index, { bigint: true });
      const bytes = readFileSync(index);
      const port = createPortRegistry(deps({ git: createGitRunner() })).get("git.status")!;
      const outcome = await port.run(env({ cwd }));
      expect(outcome).toMatchObject({
        kind: "ok",
        facts: { branch: "reflex-test", staged: 1, modified: 1, untracked: 1, unmerged: 0, clean: false },
      });
      if (outcome.kind !== "ok") throw new Error("wrong outcome");
      expect(outcome.lines.slice(2)).toEqual(["tracked file.txt", "untracked file.txt"]);
      expect(statSync(index, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
      expect(readFileSync(index)).toEqual(bytes);
      expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("returns unavailable outside a repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "reflex-no-git-"));
    try {
      expect(
        await createPortRegistry(deps({ git: createGitRunner() }))
          .get("git.status")!
          .run(env({ cwd })),
      ).toEqual({ kind: "unavailable", reason: "git unavailable" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
