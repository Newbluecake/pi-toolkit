/** F2 owned journal + real local verifier OS checks. No shell/rc execution. */
import { mkdtemp, chmod, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createTerminalResourceJournal } from "../../src/web-hub/hub/terminal/resource-fence-journal.js";
import { createLocalTerminalProofVerifier } from "../../src/web-hub/hub/terminal/resource-fence.js";
import {
  TERMINAL_JOURNAL_FILE,
  type TerminalJournal,
  type TerminalResourceEntry,
  type TerminalReapProof,
} from "../../src/web-hub/protocol/terminal.js";
import { projectOf } from "../tiers.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true });
});
async function dir() {
  const p = await mkdtemp(join(tmpdir(), "tj-"));
  await chmod(p, 0o700);
  dirs.push(p);
  return p;
}
const signal = new AbortController().signal;
const row: TerminalResourceEntry = {
  identity: { agentSessionId: "s", termId: "t", epoch: "e", ownerInstance: "o", reservationId: "r" },
  agentProcessIdentity: { bootId: "b", pid: 10, starttime: "1", uid: 1 },
  managed: [],
  spawnState: "pending",
  state: "reserved",
};
const journal: TerminalJournal = { v: 1, revision: 1, resources: [{ entry: row, status: "unresolved" }] };
describe("F2 journal and local proof (§5.5.1)", () => {
  it("integration ownership is explicit without changing frozen tiers", () => {
    expect(projectOf("tests/integration/web-hub-terminal-journal.test.ts")).toBe("tier2");
  });
  it("missing/corrupt old stores are unavailable, never implicitly empty; only trusted-new authority initializes", async () => {
    const p = await dir();
    expect((await createTerminalResourceJournal({ stateDir: p, now: Date.now }).load(signal)).kind).toBe("unavailable");
    const j = createTerminalResourceJournal({ stateDir: p, now: Date.now, trustedNew: async () => true });
    expect((await j.load(signal)).kind).toBe("trusted-new");
    expect(await j.commit(0, journal, signal)).toBe("committed");
    expect(await j.commit(0, journal, signal)).toBe("conflict");
    expect(await createTerminalResourceJournal({ stateDir: p, now: Date.now }).load(signal)).toEqual({
      kind: "loaded",
      journal,
    });
    await rm(join(p, TERMINAL_JOURNAL_FILE));
    expect((await createTerminalResourceJournal({ stateDir: p, now: Date.now }).load(signal)).kind).toBe("unavailable");
    await writeFile(join(p, TERMINAL_JOURNAL_FILE), "{broken", { mode: 0o600 });
    expect(
      (await createTerminalResourceJournal({ stateDir: p, now: Date.now, trustedNew: async () => true }).load(signal))
        .kind,
    ).toBe("unavailable");
  });
  it("owned 0700 directory and owned regular 0600 no-follow file are mandatory; symlink targets untouched", async () => {
    const p = await dir(),
      target = join(p, "target");
    await writeFile(target, "sensitive-test-sentinel", { mode: 0o600 });
    await symlink(target, join(p, TERMINAL_JOURNAL_FILE));
    expect(
      (await createTerminalResourceJournal({ stateDir: p, now: Date.now, trustedNew: async () => true }).load(signal))
        .kind,
    ).toBe("unavailable");
    expect(await readFile(target, "utf8")).toBe("sensitive-test-sentinel");
    await rm(join(p, TERMINAL_JOURNAL_FILE));
    await writeFile(join(p, TERMINAL_JOURNAL_FILE), JSON.stringify(journal), { mode: 0o644 });
    expect((await createTerminalResourceJournal({ stateDir: p, now: Date.now }).load(signal)).kind).toBe("unavailable");
    await chmod(join(p, TERMINAL_JOURNAL_FILE), 0o600);
    await chmod(p, 0o755);
    expect((await createTerminalResourceJournal({ stateDir: p, now: Date.now }).load(signal)).kind).toBe("unavailable");
  });
  it("concurrent writers cannot get two CAS successes, unresolved metadata is durable before restart", async () => {
    const p = await dir(),
      j = createTerminalResourceJournal({ stateDir: p, now: Date.now, trustedNew: async () => true });
    await j.load(signal);
    const r = await Promise.all([j.commit(0, journal, signal), j.commit(0, journal, signal)]);
    expect(r.filter((x) => x === "committed")).toHaveLength(1);
    const stat = await import("node:fs/promises").then((m) => m.stat(join(p, TERMINAL_JOURNAL_FILE)));
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = await readFile(join(p, TERMINAL_JOURNAL_FILE), "utf8");
    expect(JSON.parse(raw)).toEqual(journal);
    for (const field of ["cwd", "grant", "writerLease", "bytesB64", "connectionToken"])
      expect(raw).not.toContain(field);
    const bad = structuredClone(journal);
    bad.revision = 2;
    bad.resources.push({ ...bad.resources[0]!, entry: { ...row, identity: { ...row.identity, termId: "other" } } });
    expect(await j.commit(1, bad, signal)).toBe("unavailable");
  });
  it("local verifier refuses missing receipt, live identity, malformed/unknown proc facts; PID reuse is identity-safe", async () => {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      stat = await readFile(`/proc/${process.pid}/stat`, "utf8"),
      tail = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(" ");
    const managed = {
      bootId: boot,
      pid: process.pid,
      starttime: tail[19]!,
      uid: process.getuid!(),
      sid: Number(tail[3]),
      pgid: Number(tail[2]),
      role: "helper" as const,
    };
    const entry = {
      ...row,
      agentProcessIdentity: { bootId: boot, pid: process.pid, starttime: tail[19]!, uid: process.getuid!() },
      managed: [managed],
    };
    const proof: TerminalReapProof = {
      identity: entry.identity,
      agentProcessIdentity: entry.agentProcessIdentity,
      hubBootId: "hub",
      challengeId: "challenge",
      linkGen: 1,
      inventoryId: "inventory",
      revision: 1,
      proofId: "proof",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [managed],
      outcome: "reaped",
    };
    expect(await createLocalTerminalProofVerifier({ receipt: () => false })(proof, entry, signal)).toBe(false);
    expect(await createLocalTerminalProofVerifier({ receipt: () => true })(proof, entry, signal)).toBe(false); // current real PID is alive
    const reused = { ...entry, managed: [{ ...managed, starttime: String(BigInt(managed.starttime) + 1n) }] };
    expect(
      await createLocalTerminalProofVerifier({ receipt: () => true })(
        { ...proof, identitiesChecked: reused.managed },
        reused,
        signal,
      ),
    ).toBe(true); // not the registered old identity
    const p = await dir();
    await import("node:fs/promises").then((m) => m.mkdir(join(p, "sys/kernel/random"), { recursive: true }));
    await writeFile(join(p, "sys/kernel/random/boot_id"), boot);
    await import("node:fs/promises").then((m) => m.mkdir(join(p, String(process.pid))));
    await writeFile(join(p, String(process.pid), "stat"), "unreadable metadata");
    await writeFile(join(p, String(process.pid), "status"), "Uid: ???");
    expect(await createLocalTerminalProofVerifier({ receipt: () => true, procRoot: p })(proof, entry, signal)).toBe(
      false,
    );
  });
});
