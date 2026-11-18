import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointCli, checkpointTerminalV2 } from "../../scripts/web-hub/terminal-v2-checkpoint.js";
import { MaintenanceError } from "../../scripts/web-hub/terminal-v2-maintenance/audit.js";
import { HeldDirectory } from "../../scripts/web-hub/terminal-v2-maintenance/files.js";
import { legacyLayout, put, setup, tree } from "./helpers.js";

describe("P5 checkpoint: private real-fs + explicitly controlled audit (not real migration)", () => {
  it("fresh writes durable closed marker/ledger/witness and evidence; repeated call is byte/inode identical", async () => {
    const h = setup();
    const result = await checkpointTerminalV2("fresh", h.options);
    expect(result.outcome).toBe("committed");
    expect(h.audit.releaseCount).toBe(1);
    const marker = JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/marker.json"), "utf8"));
    expect(marker).toMatchObject({ v: 2, initialization: "fresh", checkpointId: result.checkpointId });
    expect(JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/ledger.json"), "utf8"))).toEqual({
      v: 2,
      storeId: marker.storeId,
      revision: 0,
      allocations: [],
    });
    expect(JSON.parse(readFileSync(join(h.stateDir, ".terminal-initialized-v2"), "utf8"))).toEqual(marker);
    expect(lstatSync(join(h.stateDir, "terminal-v2")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(h.stateDir, ".terminal-initialized-v2")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(h.evidenceDir, result.transaction, "complete.json"), "utf8"))).toEqual({
      v: 1,
      checkpointId: result.checkpointId,
      kind: "checkpoint-durable",
    });
    const before = tree(h.base);
    expect((await checkpointTerminalV2("fresh", h.options)).outcome).toBe("already-complete");
    expect(tree(h.base)).toEqual(before);
  });

  it("uses the frozen P0 semantic witness match without rewriting equivalent JSON", async () => {
    const h = setup();
    await checkpointTerminalV2("fresh", h.options);
    const path = join(h.stateDir, ".terminal-initialized-v2");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    put(
      path,
      JSON.stringify({
        checkpointId: marker.checkpointId,
        initialization: marker.initialization,
        storeId: marker.storeId,
        v: 2,
      }) + "\n\n",
    );
    const before = tree(h.base);
    expect((await checkpointTerminalV2("fresh", h.options)).outcome).toBe("already-complete");
    expect(tree(h.base)).toEqual(before);
  });

  it("clean v1 preserves original bytes/inodes and nonzero revision, records exact snapshots", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    const before = tree(h.stateDir);
    const result = await checkpointTerminalV2("checkpoint", h.options);
    for (const [path, value] of Object.entries(before)) expect(tree(h.stateDir)[path]).toBe(value);
    const manifest = JSON.parse(readFileSync(join(h.evidenceDir, result.transaction, "prepared.json"), "utf8"));
    expect(manifest.operation).toBe("checkpoint");
    expect(manifest.audit.legacy.durableRevision).toBe(7);
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "terminal-v1/initialized",
      ".terminal-initialized-v1",
      "terminal-v1/terminal-resource-fence-v1.json",
    ]);
    manifest.files.forEach((f: { path: string; fingerprint: { ino: number; sha256: string } }, i: number) => {
      expect(readFileSync(join(h.evidenceDir, result.transaction, `snapshot-${i}`))).toEqual(
        readFileSync(join(h.stateDir, f.path)),
      );
      expect(f.fingerprint.ino).toBe(lstatSync(join(h.stateDir, f.path)).ino);
      expect(f.fingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
    expect((await checkpointTerminalV2("checkpoint", h.options)).outcome).toBe("already-complete");
  });

  it("reads an actual v1 initializer's private empty store, not a real shell drain", async () => {
    const h = setup();
    const { initializeTerminalStore, checkTerminalStore } =
      await import("../../src/web-hub/protocol/terminal-local.js");
    const store = await initializeTerminalStore(h.stateDir);
    expect(checkTerminalStore(h.stateDir).storeId).toBe(store.storeId);
    h.audit.revision = 0;
    const before = tree(join(h.stateDir, "terminal-v1"));
    expect((await checkpointTerminalV2("checkpoint", h.options)).outcome).toBe("committed");
    expect(tree(join(h.stateDir, "terminal-v1"))).toEqual(before);
  });

  it.each([
    "terminal-v1",
    ".terminal-initialized-v1",
    "terminal-resource-fence-v1.json",
    ".terminal-authority-archive-v1",
  ])("fresh refuses any prior legacy artifact: %s, no writes", async (name) => {
    const h = setup();
    if (name === "terminal-v1" || name === ".terminal-authority-archive-v1")
      mkdirSync(join(h.stateDir, name), { mode: 0o700 });
    else put(join(h.stateDir, name), "old");
    const before = tree(h.base);
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ effect: "none" });
    expect(tree(h.base)).toEqual(before);
  });

  it.each(["resources", "receipts", "authority", "unknown", "version", "permissions", "symlink", "flat"])(
    "dirty/unsafe v1 %s refuses without modification",
    async (kind) => {
      const h = setup();
      legacyLayout(h.stateDir);
      const root = join(h.stateDir, "terminal-v1");
      if (kind === "resources")
        put(join(root, "terminal-resource-fence-v1.json"), { v: 1, revision: 7, resources: [{}] });
      if (kind === "receipts" || kind === "authority") put(join(root, kind, "unknown.json"), {});
      if (kind === "unknown") put(join(root, "other"), {});
      if (kind === "version") put(join(root, "initialized"), { v: 99, storeId: "L".repeat(32) });
      if (kind === "permissions") chmodSync(root, 0o755);
      if (kind === "symlink") {
        renameSync(join(root, "initialized"), join(h.base, "original-initialized"));
        symlinkSync(join(h.base, "original-initialized"), join(root, "initialized"));
      }
      if (kind === "flat")
        put(join(h.stateDir, "terminal-resource-fence-v1.json"), { v: 1, revision: 0, resources: [] });
      const before = tree(h.base);
      await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toMatchObject({ effect: "none" });
      expect(tree(h.base)).toEqual(before);
    },
  );

  it.each(["publisher", "active", "pending", "version"])(
    "trusted audit rejects %s before evidence/state writes",
    async (fault) => {
      const h = setup();
      legacyLayout(h.stateDir);
      if (fault === "publisher") h.audit.publisher = true;
      if (fault === "active") h.audit.active = 1;
      if (fault === "pending") h.audit.pending = 1;
      if (fault === "version") h.audit.oldSource = "c".repeat(40);
      const before = tree(h.base);
      await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toMatchObject({ effect: "none" });
      expect(tree(h.base)).toEqual(before);
      expect(h.audit.locked).toBe(false);
    },
  );

  it("rechecks inode/bytes after async OS revalidation and rejects publisher restart", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    h.audit.onRevalidate = () => {
      h.audit.publisher = true;
    };
    const before = tree(h.base);
    await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toMatchObject({ code: "old-publisher-active" });
    expect(tree(h.base)).toEqual(before);
  });

  it("rejects a modified journal between observation and mutation, retaining all old state", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    h.audit.onRevalidate = () =>
      put(join(h.stateDir, "terminal-v1/terminal-resource-fence-v1.json"), { v: 1, revision: 8, resources: [] });
    await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toMatchObject({ code: "file-changed" });
    expect(existsSync(join(h.stateDir, "terminal-v2"))).toBe(false);
    expect(readdirSync(h.evidenceDir)).toEqual([]);
  });

  it("checkpoint detects directory replacement across async revalidation, no redirected write", async () => {
    const h = setup();
    h.audit.onRevalidate = () => {
      renameSync(h.stateDir, join(h.base, "replaced-state"));
      mkdirSync(h.stateDir, { mode: 0o700 });
    };
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ code: "directory-replaced" });
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(readdirSync(join(h.base, "replaced-state"))).toEqual([]);
    expect(readdirSync(h.evidenceDir)).toEqual([]);
  });

  it("directory replacement cannot redirect a held directory write", () => {
    const h = setup();
    const dir = new HeldDirectory(h.stateDir);
    renameSync(h.stateDir, join(h.base, "old-state"));
    mkdirSync(h.stateDir, { mode: 0o700 });
    try {
      expect(() => dir.create("bad", Buffer.from("bad"))).toThrow("directory-replaced");
    } finally {
      dir.close();
    }
    expect(readdirSync(h.stateDir)).toEqual([]);
    expect(readdirSync(join(h.base, "old-state"))).toEqual([]);
  });

  it("forbids symlink ancestors and overlapping evidence roots", async () => {
    const h = setup();
    symlinkSync(h.stateDir, join(h.base, "link"));
    await expect(checkpointTerminalV2("fresh", { ...h.options, stateDir: join(h.base, "link") })).rejects.toMatchObject(
      { code: "unsafe-path-chain" },
    );
    await expect(checkpointTerminalV2("fresh", { ...h.options, evidenceDir: h.stateDir })).rejects.toMatchObject({
      code: "overlapping-paths",
    });
    expect(readdirSync(h.stateDir)).toEqual([]);
  });

  it("CLI does not accept JSON/booleans/force or infer defaults, even when flags look valid", () => {
    expect(checkpointCli(["--help"]).exitCode).toBe(0);
    for (const args of [[], ["--drained=true"], ["--force"], ["--state", "/explicit", "--proof", "{}"]]) {
      expect(checkpointCli(args)).toMatchObject({ exitCode: 78 });
      expect(checkpointCli(args).message).toContain("no maintenance performed");
    }
  });

  it.each(["evidence-write", "evidence-sync", "state-write", "state-sync", "complete-write"] as const)(
    "ENOSPC at %s retains partial evidence; never repairs on retry",
    async (stage) => {
      const h = setup();
      legacyLayout(h.stateDir);
      const before = tree(join(h.stateDir, "terminal-v1"));
      await expect(
        checkpointTerminalV2("checkpoint", h.options, {
          before(s) {
            if (s === stage) throw Object.assign(new Error("disk"), { code: "ENOSPC" });
          },
        }),
      ).rejects.toMatchObject({ code: "io-ENOSPC" });
      expect(tree(join(h.stateDir, "terminal-v1"))).toEqual(before);
      expect(readdirSync(h.evidenceDir).length).toBe(1);
      const retained = tree(h.base);
      if (stage === "state-sync" || stage === "complete-write") {
        await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toBeInstanceOf(MaintenanceError);
        expect(tree(h.base)).toEqual(retained);
      }
    },
  );

  it("crash model after durable ledger but before marker leaves partials, retry never heals", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    let writes = 0;
    await expect(
      checkpointTerminalV2("checkpoint", h.options, {
        before(stage) {
          if (stage === "state-write" && ++writes === 3) throw new MaintenanceError("simulated-crash-before-marker");
        },
      }),
    ).rejects.toMatchObject({ code: "simulated-crash-before-marker", effect: "unknown" });
    expect(existsSync(join(h.stateDir, "terminal-v2/ledger.json"))).toBe(true);
    expect(existsSync(join(h.stateDir, "terminal-v2/marker.json"))).toBe(false);
    const before = tree(h.base);
    await expect(checkpointTerminalV2("checkpoint", h.options)).rejects.toMatchObject({ effect: "none" });
    expect(tree(h.base)).toEqual(before);
  });

  it("singleton covers async validation and commit, no second writer", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquire = h.audit.acquire.bind(h.audit);
    h.audit.acquire = async (input) => {
      const lease = await acquire(input);
      const validate = lease.revalidate;
      lease.revalidate = async (snapshot) => {
        await gate;
        return validate(snapshot);
      };
      return lease;
    };
    const first = checkpointTerminalV2("fresh", h.options);
    // Advance microtasks to the explicit barrier; no wall clock wait.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.audit.locked).toBe(true);
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ code: "singleton-busy" });
    release();
    expect((await first).outcome).toBe("committed");
    expect(h.audit.locked).toBe(false);
  });
});
