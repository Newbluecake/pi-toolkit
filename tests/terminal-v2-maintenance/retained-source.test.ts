/** Real private filesystem + explicit O disk fixtures; NOT a real O publisher test. */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HeldDirectory, digest, json } from "../../scripts/web-hub/terminal-v2-maintenance/files.js";
import { captureTerminalSource } from "../../scripts/web-hub/terminal-v2-retained/snapshot.js";
import { readRetainedSource } from "../../scripts/web-hub/terminal-v2-retained/source-reader.js";
import { backupTerminalSource } from "../../scripts/web-hub/terminal-v2-retained/backup.js";
import { mapRetainedObligations } from "../../scripts/web-hub/terminal-v2-retained/mapping.js";
import { legacyLayout, put, setup, tree } from "./helpers.js";
const identity = {
  agentSessionId: "old-session",
  termId: "term",
  epoch: "epoch",
  ownerInstance: "owner",
  reservationId: "reservation",
};
const processIdentity = {
  bootId: "11111111-1111-4111-8111-111111111111",
  pid: 123,
  starttime: "12",
  uid: process.getuid!(),
};
const row = {
  entry: { identity, agentProcessIdentity: processIdentity, managed: [], spawnState: "settled", state: "live" },
  status: "unresolved",
};
function fixture() {
  const h = setup();
  legacyLayout(h.stateDir);
  const state = new HeldDirectory(h.stateDir),
    path = join(h.stateDir, "terminal-v1/terminal-resource-fence-v1.json");
  put(path, { v: 1, revision: 7, resources: [row] });
  return { ...h, state, path };
}
it("captures exact nonempty sources and empty directories; backs up opaque regular bytes, never reads/copies auth", () => {
  const h = fixture();
  mkdirSync(join(h.stateDir, "terminal-v1/opaque-empty"), { mode: 0o700 });
  writeFileSync(join(h.stateDir, "terminal-v1/notes 中文 #.txt"), "opaque\0bytes", { mode: 0o644 });
  // Unreadable/nonregular auth-domain targets are out of scope, not migration failures.
  symlinkSync("/no-such-auth-target", join(h.stateDir, "hub.db"));
  put(join(h.stateDir, "token"), "never copy");
  const before = tree(h.stateDir),
    snapshot = captureTerminalSource(h.state, () => {});
  const backupDir = new HeldDirectory(h.evidenceDir);
  try {
    const inventory = readRetainedSource(snapshot);
    expect(inventory.resources).toHaveLength(1);
    expect(inventory.resources[0]!.identity).toEqual(identity);
    expect(inventory.producers[0]!.process).toEqual(processIdentity);
    expect(inventory.opaqueFiles).toEqual(["terminal-v1/notes 中文 #.txt"]);
    expect(snapshot.manifest.directories.find((d) => d.path.endsWith("opaque-empty"))!.members).toEqual([]);
    expect(snapshot.manifest.files.some((f) => /hub.db|token/.test(f.path))).toBe(false);
    const backup = backupTerminalSource(snapshot, backupDir, () => {});
    backup.verify();
    expect(backup.manifestSha256).toBe(digest(json(snapshot.manifest)));
    const index = JSON.parse(readFileSync(join(h.evidenceDir, "backup-index.json"), "utf8"));
    const opaque = index.files.find((f: { source: string }) => f.source.endsWith("notes 中文 #.txt"));
    expect(readFileSync(join(h.evidenceDir, opaque.backup))).toEqual(Buffer.from("opaque\0bytes"));
    expect(tree(h.stateDir)).toEqual(before);
    expect(() => backupTerminalSource(snapshot, backupDir, () => {})).toThrow("E_BACKUP_NOT_EMPTY");
  } finally {
    snapshot.close();
    backupDir.close();
    h.state.close();
  }
});
it("zero is a valid old installation, not fresh; missing witness/journal never guesses zero", () => {
  const h = fixture();
  put(h.path, { v: 1, revision: 9, resources: [] });
  const snapshot = captureTerminalSource(h.state, () => {});
  try {
    expect(readRetainedSource(snapshot).resources).toEqual([]);
  } finally {
    snapshot.close();
    h.state.close();
  }
  const fresh = setup(),
    state = new HeldDirectory(fresh.stateDir),
    s = captureTerminalSource(state, () => {});
  try {
    expect(() => readRetainedSource(s)).toThrow("E_SOURCE_MISSING");
  } finally {
    s.close();
    state.close();
  }
});
it("receipts add conservative debt and compatible source refs, regardless of claimed physical reaping", () => {
  const h = fixture(),
    id = "r".repeat(32);
  put(join(h.stateDir, `terminal-v1/receipts/${id}.json`), {
    v: 1,
    recordId: id,
    nonce: "n".repeat(32),
    storeId: "L".repeat(32),
    ownerRecordId: "o".repeat(32),
    identity,
    agentProcessIdentity: processIdentity,
    physical: {
      outcome: "reaped",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [],
      waited: [],
    },
  });
  const snapshot = captureTerminalSource(h.state, () => {});
  try {
    const inventory = readRetainedSource(snapshot),
      rows = mapRetainedObligations("a".repeat(64), snapshot.manifestSha256, inventory.resources);
    expect(inventory.resources).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceRecordKeys).toHaveLength(2);
    expect(rows[0]!.sessionBinding).toEqual({ kind: "verified", sessionId: "old-session" });
    expect(rows[0]!.kernelBinding).toEqual({ kind: "known", bootId: processIdentity.bootId });
  } finally {
    snapshot.close();
    h.state.close();
  }
});
it.each([
  "duplicate",
  "reservation-conflict",
  "resolved-no-proof",
  "bad-shape",
  "flat-conflict",
  "pending-authority",
  "partial-archive",
])("refuses damaged/ambiguous authoritative range: %s", (fault) => {
  const h = fixture();
  if (fault === "duplicate") put(h.path, { v: 1, revision: 7, resources: [row, row] });
  if (fault === "reservation-conflict")
    put(h.path, {
      v: 1,
      revision: 7,
      resources: [row, { ...row, entry: { ...row.entry, identity: { ...identity, termId: "other" } } }],
    });
  if (fault === "resolved-no-proof") put(h.path, { v: 1, revision: 7, resources: [{ ...row, status: "resolved" }] });
  if (fault === "bad-shape") put(h.path, { v: 1, revision: 7, resources: [], extra: true });
  if (fault === "flat-conflict")
    put(join(h.stateDir, "terminal-resource-fence-v1.json"), { v: 1, revision: 1, resources: [] });
  if (fault === "pending-authority") put(join(h.stateDir, "terminal-v1/authority/.pending-" + "p".repeat(32)), {});
  if (fault === "partial-archive") {
    const path = join(h.stateDir, ".terminal-authority-archive-v1");
    mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(path, "t".repeat(32)), { mode: 0o700 });
  }
  const before = tree(h.stateDir),
    snapshot = captureTerminalSource(h.state, () => {});
  try {
    expect(() => readRetainedSource(snapshot)).toThrow();
    expect(tree(h.stateDir)).toEqual(before);
  } finally {
    snapshot.close();
    h.state.close();
  }
});
it.each(["bytes", "file-inode", "membership", "empty-inode", "mode"])(
  "pins source changes before commit: %s",
  (fault) => {
    const h = fixture();
    mkdirSync(join(h.stateDir, "terminal-v1/empty"), { mode: 0o700 });
    const s = captureTerminalSource(h.state, () => {});
    try {
      if (fault === "bytes") put(h.path, { v: 1, revision: 8, resources: [] });
      if (fault === "file-inode") {
        renameSync(h.path, h.path + ".old");
        put(h.path, { v: 1, revision: 7, resources: [row] });
      }
      if (fault === "membership") put(join(h.stateDir, "terminal-v1/new"), "new");
      if (fault === "empty-inode") {
        renameSync(join(h.stateDir, "terminal-v1/empty"), join(h.stateDir, "terminal-v1/old-empty"));
        mkdirSync(join(h.stateDir, "terminal-v1/empty"), { mode: 0o700 });
      }
      if (fault === "mode") chmodSync(h.path, 0o644);
      expect(() => s.verify()).toThrow();
    } finally {
      s.close();
      h.state.close();
    }
  },
);
it.each(["symlink", "hardlink", "group-writable", "file-cap", "depth-cap", "member-cap"])(
  "fails closed without following/repairing unsafe terminal source: %s",
  (fault) => {
    const h = fixture(),
      target = join(h.stateDir, "terminal-v1/extra");
    if (fault === "symlink") symlinkSync(h.path, target);
    if (fault === "hardlink") linkSync(h.path, target);
    if (fault === "group-writable") chmodSync(h.path, 0o620);
    if (fault === "file-cap") writeFileSync(target, Buffer.alloc(16 * 1024 * 1024), { mode: 0o600 });
    if (fault === "depth-cap") {
      let p = join(h.stateDir, "terminal-v1");
      for (let n = 0; n < 8; n++) {
        p = join(p, "nested");
        mkdirSync(p, { mode: 0o700 });
      }
    }
    if (fault === "member-cap") for (let n = 0; n < 513; n++) put(`${target}${n}`, "x");
    const before = tree(h.stateDir);
    try {
      expect(() => captureTerminalSource(h.state, () => {})).toThrow();
      expect(tree(h.stateDir)).toEqual(before);
    } finally {
      h.state.close();
    }
  },
);
it("completed archives are authority-only history, never new resources or a physical release", () => {
  const h = fixture(),
    tx = "t".repeat(32),
    recordId = "r".repeat(32);
  const archive = join(h.stateDir, ".terminal-authority-archive-v1"),
    path = join(archive, tx);
  for (const dir of [archive, path, join(path, "snapshots"), join(path, "retired")]) mkdirSync(dir, { mode: 0o700 });
  const authority = {
    v: 1,
    recordId,
    nonce: "n".repeat(32),
    storeId: "L".repeat(32),
    agentNonce: "agent",
    sessionId: "old-session",
    epoch: "epoch",
    ownerInstance: "owner",
    process: processIdentity,
    namespaces: { pid: "pid:[1]", mnt: "mnt:[2]", user: "user:[3]" },
    domain: "plain",
    main: true,
    active: true,
    createdAt: 1,
  };
  const retiredPath = join(path, `retired/${recordId}.json`),
    snapshotPath = join(path, `snapshots/${recordId}.json`);
  put(retiredPath, authority);
  put(snapshotPath, authority);
  const st = lstatSync(retiredPath),
    bytes = readFileSync(retiredPath);
  put(join(path, "manifest.json"), {
    v: 1,
    kind: "authority-retirement-only",
    transaction: tx,
    storeId: "L".repeat(32),
    currentBoot: processIdentity,
    journalRevision: 1,
    journalHash: "a".repeat(64),
    candidates: [
      {
        name: `${recordId}.json`,
        process: processIdentity,
        fingerprint: {
          dev: st.dev,
          ino: st.ino,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          hash: digest(bytes),
        },
      },
    ],
  });
  put(join(path, "complete.json"), { v: 1, kind: "authority-retirement-only" });
  const s = captureTerminalSource(h.state, () => {});
  try {
    const inventory = readRetainedSource(s);
    expect(inventory.resources).toHaveLength(1);
    expect(inventory.authorities).toHaveLength(2);
    expect(inventory.opaqueFiles).toEqual([]);
    expect(inventory.producers).toHaveLength(4);
  } finally {
    s.close();
    h.state.close();
  }
});
it("auth-domain writes do not invalidate a terminal-only snapshot, but guard loss does", () => {
  const h = fixture();
  let valid = true;
  const s = captureTerminalSource(h.state, () => {
    if (!valid) throw new Error("lease-lost");
  });
  try {
    put(join(h.stateDir, "hub.db-wal"), "changed auth");
    s.verify();
    valid = false;
    expect(() => s.verify()).toThrow("lease-lost");
  } finally {
    s.close();
    h.state.close();
  }
});
