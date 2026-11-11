import * as fs from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { fixture, action, host } from "../memory/govern/revision-e-helpers.js";
import { registeredRecovery, treeBytes } from "./helpers/memory-revision-native.js";
import { withMemoryDirLock } from "../../src/memory/lock.js";
import * as auditModule from "../../src/memory/govern/revision-audit.js";
import * as safeFs from "../../src/memory/safe-fs.js";
import { classifyMemoryCommand, needsConfirm } from "../../src/memory/command-policy.js";
import { executeMemoryRead } from "../../src/memory/command-readonly.js";
import { RenderCache } from "../../src/memory/render.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";

async function committed(kind = "rewrite-single", authority: "agent" | "user" = "agent") {
  const h = await fixture(false, authority);
  let owned = { frozen: h.frozen, proposal: h.proposal };
  if (kind === "merge-survivor") {
    const frozen = await h.freeze(1, "merge-survivor");
    const p = await h.prepare(frozen);
    if (p.kind !== "ok") throw Error("real merge preparation failed");
    owned = { frozen, proposal: p.proposal };
  } else if (kind === "retire" || kind === "delete") {
    if (kind === "delete")
      fs.writeFileSync(
        h.targetPath,
        h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
      );
    owned = await action(h, kind);
  }
  const before = fs.readFileSync(h.targetPath);
  const x = await host(h, { ...owned, generationMaxOutputTokens: 2048, coverageMaxOutputTokens: 2048 });
  expect((await x.commit("web-b3")).kind).toBe("committed");
  const auditPath = join(h.actionPath(owned.frozen), "audit.json");
  return { h, owned, before, auditPath, args: `restore --revision ${owned.frozen.actionId}` };
}

it.each([
  ["rewrite-single", "agent"],
  ["rewrite-single", "user"],
  ["merge-survivor", "agent"],
  ["merge-survivor", "user"],
  ["retire", "agent"],
  ["retire", "user"],
  ["delete", "agent"],
] as const)(
  "registered %s/%s: one exact native confirm → original C raw bytes, target only, revision callback",
  async (kind, authority) => {
    const { h, owned, before, auditPath, args } = await committed(kind, authority);
    const r = await registeredRecovery(h);
    r.settings.governance.enabled = true; // after natural startup; no sweep/model work
    const context = fs.readFileSync(h.contextPath);
    const record = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    const generation = r.scopes!.activity!()!.snapshot(Date.now()).generation;
    // Recovery has no current registry, no binding, cap=0, auto=false and Jev off.
    Object.defineProperty(r.ctx, "modelRegistry", {
      configurable: true,
      get() {
        throw Error("provider unavailable: must not be consulted");
      },
    });
    r.memory.renderForExternal("/");
    const cacheInvalidation = vi.spyOn(RenderCache.prototype, "delete");
    const mutations: string[] = [];
    const replace = safeFs.replaceRevisionObserved;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      if (args[0] === h.blocks) {
        const intent = JSON.parse(fs.readFileSync(auditPath, "utf8"));
        expect(intent.restoreAttempt.state).toBe("intent");
        expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
        mutations.push(args[2]);
      }
      return replace(...args);
    });
    const create = safeFs.createRevisionObserved;
    vi.spyOn(safeFs, "createRevisionObserved").mockImplementation((...args) => {
      if (args[0] === h.blocks) {
        expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt.state).toBe("intent");
        expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
        mutations.push(args[2]);
      }
      return create(...args);
    });
    r.ui.confirm.mockImplementation(async (_title, text) => {
      expect(fs.existsSync(join(h.dir, ".lock"))).toBe(false);
      // An actual competing lock succeeds DURING the popup: no lock held waiting.
      expect(await withMemoryDirLock(h.dir, () => "free")).toBe("free");
      for (const value of [
        owned.frozen.actionId,
        record.targetId,
        record.expectedRev,
        record.beforeDigest,
        before.toString("utf8"),
      ])
        expect(text).toContain(value);
      for (const [key, value] of Object.entries(record.expectedAfter))
        expect(text).toContain(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
      expect(text).toContain(`${h.blocks}/rules.001.md`);
      expect(text).toContain("不增加 version");
      return true;
    });
    await r.run(args);
    expect(r.ui.confirm).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(h.targetPath)).toEqual(before); // BOM, CRLF, café/规则 and version 7
    expect(before.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(fs.readFileSync(h.contextPath)).toEqual(context);
    expect(mutations).toEqual(["rules.001.md"]);
    expect(JSON.parse(fs.readFileSync(auditPath, "utf8"))).toMatchObject({ state: "restored" });
    expect(r.afterWrite).toHaveBeenCalledTimes(1);
    expect(r.afterWrite).toHaveBeenCalledWith("/", "revision");
    expect(r.scopes!.activity!()!.snapshot(Date.now()).generation).toBeGreaterThan(generation);
    expect(cacheInvalidation).toHaveBeenCalledWith("/");
    expect(r.ui.notify.mock.calls.at(-1)?.[0]).toMatch(/^restore --revision: restored /);
  },
);

it.each(["rpc", "no-ui", "no-confirm", "web", "child", "secure", "locked", "no-owner", "disabled", "gate"])(
  "registered early %s refusal: zero C discovery, confirm, writes or invalidation",
  async (mode) => {
    const { h, args } = await committed();
    const r = await registeredRecovery(h, {
      ...(mode === "secure" || mode === "locked" ? { domain: mode } : {}),
      ...(mode === "child" ? { child: true } : {}),
      ...(mode === "no-owner" ? { noScopes: true } : {}),
      ...(mode === "disabled" ? { disabled: true } : {}),
    });
    const confirmation = r.ui.confirm;
    if (mode === "rpc") Object.assign(r.ctx, { mode: "rpc", hasUI: true });
    if (mode === "no-ui") Object.assign(r.ctx, { hasUI: false });
    if (mode === "no-confirm") Object.assign(r.ui, { confirm: undefined });
    if (mode === "web") Object.assign(r.ctx, { webInvocation: true });
    if (mode === "gate") r.state.gate = false;
    const preview = vi.spyOn(auditModule, "previewRevisionRestore");
    const raw = vi.spyOn(auditModule, "restoreRevisionRaw");
    const bytes = treeBytes(h.dir);
    await r.run(args);
    expect(preview).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    expect(confirmation).not.toHaveBeenCalled();
    expect(treeBytes(h.dir)).toEqual(bytes);
    expect(r.afterWrite).not.toHaveBeenCalled();
  },
);

it.each([
  "restore --revision",
  "restore --revision BAD",
  `restore --revision ${"A".repeat(64)}`,
  `restore --revision ${"a".repeat(63)}`,
  `restore --revision ${"a".repeat(65)}`,
  `restore --revision ${"a".repeat(64)} extra`,
  `restore --revision --revision ${"a".repeat(64)}`,
  `restore --trash --revision ${"a".repeat(64)}`,
  `restore --block --revision ${"a".repeat(64)}`,
  `restore --legacy --revision ${"a".repeat(64)}`,
  `restore ${"a".repeat(64)} --revision`,
])("strict native/Web grammar refuses %s before discovery", async (args) => {
  const h = await fixture();
  const r = await registeredRecovery(h);
  const preview = vi.spyOn(auditModule, "previewRevisionRestore");
  const bytes = treeBytes(h.dir);
  await r.run(args);
  expect(preview).not.toHaveBeenCalled();
  expect(r.ui.confirm).not.toHaveBeenCalled();
  expect(treeBytes(h.dir)).toEqual(bytes);
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("usage: /mem restore --revision");
  expect(classifyMemoryCommand(args)).toBe("unknown");
  expect(needsConfirm(args)).toBe(true);
  expect(executeMemoryRead(args, "/", { memoryRoot: h.dir, ccProjectsRoot: h.dir })).toMatchObject({
    ok: false,
    code: "E_MEM_WEB_UNSUPPORTED",
    message: expect.stringContaining("原生 TUI"),
  });
});

it("valid revision is destructive, never a Web read or discovery/completion change", async () => {
  const h = await fixture();
  const r = await registeredRecovery(h);
  const args = `restore --revision ${h.frozen.actionId}`;
  expect(classifyMemoryCommand(args)).toBe("destructive");
  expect(executeMemoryRead(args, "/")).toMatchObject({
    ok: false,
    code: "E_MEM_WEB_UNSUPPORTED",
    message: expect.not.stringContaining("tidy"),
  });
  const command = r.commands.get("mem");
  expect(command.description).not.toContain("--revision");
  expect(command.getArgumentCompletions("restore ").some((x: { value: string }) => x.value.includes("revision"))).toBe(
    false,
  );
});

it.each([
  "prepared",
  "proposed",
  "commit-unknown",
  "restored",
  "restore-intent",
  "restore-unknown",
  "corrupt",
  "ambiguous",
  "missing-proof",
  "raw-evidence",
  "stale",
])("registered %s evidence refuses with no popup or recovery writes", async (state) => {
  const { h, args, auditPath, owned } = await committed(
    state.startsWith("restore-") ? "merge-survivor" : "rewrite-single",
  );
  const r = await registeredRecovery(h);
  const disk = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  if (["prepared", "proposed", "commit-unknown", "restored"].includes(state)) disk.state = state;
  if (state === "restore-intent" || state === "restore-unknown")
    disk.restoreAttempt = {
      state: state === "restore-intent" ? "intent" : "effect-unknown",
      startedAt: "2026-11-10T00:00:00.000Z",
    };
  if (state === "missing-proof") delete disk.commitObservation;
  if (state === "corrupt") disk.extra = "bad";
  fs.writeFileSync(auditPath, JSON.stringify(disk));
  if (state === "ambiguous") {
    const duplicate = join(h.blocks, ".jev/revisions", "f".repeat(64), owned.frozen.actionId);
    fs.mkdirSync(duplicate, { recursive: true, mode: 0o700 });
  }
  if (state === "raw-evidence") fs.appendFileSync(join(h.actionPath(owned.frozen), "before.md"), "damaged");
  if (state === "stale") fs.appendFileSync(h.targetPath, "external writer");
  const bytes = treeBytes(h.dir);
  await r.run(args);
  expect(r.ui.confirm).not.toHaveBeenCalled();
  expect(r.afterWrite).not.toHaveBeenCalled();
  expect(treeBytes(h.dir)).toEqual(bytes);
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("restore --revision refused:");
});

it.each(["cancel", "exception", "abort", "timeout"])("%s while confirming: late true cannot write", async (mode) => {
  const { h, args } = await committed();
  const r = await registeredRecovery(h);
  const bytes = treeBytes(h.dir);
  let release!: (yes: boolean) => void;
  let shown!: () => void;
  const ready = new Promise<void>((resolve) => {
    shown = resolve;
  });
  r.ui.confirm.mockImplementation(() => {
    shown();
    if (mode === "exception") throw Error("popup failed");
    if (mode === "cancel") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      release = resolve;
    });
  });
  if (mode === "timeout") vi.useFakeTimers();
  const running = r.run(args);
  await ready;
  if (mode === "abort") r.lifecycle.abort();
  if (mode === "timeout") await vi.advanceTimersByTimeAsync(120_000);
  await running;
  if (release) release(true);
  await Promise.resolve();
  expect(r.ui.confirm).toHaveBeenCalledTimes(1);
  expect(treeBytes(h.dir)).toEqual(bytes);
  expect(r.afterWrite).not.toHaveBeenCalled();
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("cancelled");
});

it.each([
  "owner",
  "manager",
  "tree",
  "sid",
  "gate",
  "disabled",
  "web",
  "audit-bytes",
  "audit-inode",
  "namespace",
  "disk-cas",
])("%s changed after exact preview/confirmation refuses without recovery intent", async (race) => {
  const { h, args, auditPath } = await committed();
  const r = await registeredRecovery(h);
  let changed: Record<string, string>;
  r.ui.confirm.mockImplementation(async () => {
    if (race === "owner") r.scopes!.dispose();
    if (race === "manager") Object.assign(r.ctx, { sessionManager: SessionManager.inMemory("/") });
    if (race === "tree") await r.emit("session_tree");
    if (race === "sid") r.manager.newSession();
    if (race === "gate") r.state.gate = false;
    if (race === "disabled") r.settings.enabled = false;
    if (race === "web") Object.assign(r.ctx, { webInvocation: true });
    if (race === "audit-bytes") fs.appendFileSync(auditPath, "\n");
    if (race === "audit-inode") {
      fs.writeFileSync(`${auditPath}.swap`, fs.readFileSync(auditPath), { mode: 0o600 });
      fs.renameSync(`${auditPath}.swap`, auditPath);
    }
    if (race === "namespace") {
      const p = join(h.blocks, ".jev/revisions");
      fs.renameSync(p, `${p}.saved`);
      fs.cpSync(`${p}.saved`, p, { recursive: true });
      fs.rmSync(`${p}.saved`, { recursive: true });
    }
    if (race === "disk-cas") fs.appendFileSync(h.targetPath, "external bytes");
    changed = treeBytes(h.dir);
    return true;
  });
  await r.run(args);
  expect(r.ui.confirm).toHaveBeenCalledTimes(1);
  expect(treeBytes(h.dir)).toEqual(changed!);
  expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt).toBeUndefined();
  expect(r.afterWrite).not.toHaveBeenCalled();
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).not.toMatch(/^restore --revision: restored /);
});

it.each(["gate", "abort", "cas"])("inside the original lock %s race rejects before intent", async (race) => {
  const { h, args, auditPath } = await committed();
  const r = await registeredRecovery(h);
  const original = safeFs.listRevisionNamesBounded;
  let once = false;
  vi.spyOn(safeFs, "listRevisionNamesBounded").mockImplementation((...args) => {
    if (!once && fs.existsSync(join(h.dir, ".lock"))) {
      once = true;
      if (race === "gate") r.state.gate = false;
      if (race === "abort") r.lifecycle.abort();
      if (race === "cas") fs.appendFileSync(h.targetPath, "lock-race");
    }
    return original(...args);
  });
  await r.run(args);
  expect(once).toBe(true);
  expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt).toBeUndefined();
  expect(r.afterWrite).not.toHaveBeenCalled();
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("refused");
});

it.each(["before-data", "post-data"])(
  "%s restore failure reports possible effect, invalidates once and fences blind retry",
  async (phase) => {
    const { h, args, auditPath, before } = await committed();
    const r = await registeredRecovery(h);
    const after = fs.readFileSync(h.targetPath);
    const replace = safeFs.replaceRevisionObserved;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      if (args[0] === h.blocks && phase === "before-data") throw Error("opaque syscall");
      const result = replace(...args);
      if (args[0] === h.blocks && phase === "post-data") r.state.gate = false;
      return result;
    });
    await r.run(args);
    expect(fs.readFileSync(h.targetPath)).toEqual(phase === "post-data" ? before : after);
    expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt.state).toBe(
      phase === "post-data" ? "intent" : "effect-unknown",
    );
    expect(r.afterWrite).toHaveBeenCalledTimes(1);
    expect(r.afterWrite).toHaveBeenCalledWith("/", "revision");
    expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("effect-unknown");
    expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("禁止盲目重试");
    r.state.gate = true;
    const bytes = treeBytes(h.dir);
    await r.run(args);
    expect(r.ui.confirm).toHaveBeenCalledTimes(1);
    expect(r.afterWrite).toHaveBeenCalledTimes(1);
    expect(treeBytes(h.dir)).toEqual(bytes);
  },
);

it("missing recovery seam with an actual owner is fail-closed before any C discovery", async () => {
  const { h, args } = await committed();
  const r = await registeredRecovery(h);
  expect(r.scopes!.current()).toBeDefined();
  delete r.deps.revisionRecovery;
  const preview = vi.spyOn(auditModule, "previewRevisionRestore");
  const bytes = treeBytes(h.dir);
  await r.run(args);
  expect(preview).not.toHaveBeenCalled();
  expect(r.ui.confirm).not.toHaveBeenCalled();
  expect(treeBytes(h.dir)).toEqual(bytes);
});

it("read-only preview exposes deeply immutable exact strings, no lock or disk writes", async () => {
  const { h, owned, before } = await committed();
  const bytes = treeBytes(h.dir);
  const result = auditModule.previewRevisionRestore(h.dir, owned.frozen.actionId, h.auditDeps);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("preview refused committed fixture");
  expect(Object.isFrozen(result.preview)).toBe(true);
  expect(Object.isFrozen(result.preview.expectedAfter)).toBe(true);
  expect(result.preview.rawBefore).toBe(before.toString("utf8"));
  expect(result.preview.auditDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(treeBytes(h.dir)).toEqual(bytes);
  expect(fs.existsSync(join(h.dir, ".lock"))).toBe(false);
});

it("original Jev cache invalidator runs after native recovery despite no registry/provider", async () => {
  const { h, args, before } = await committed();
  const r = await registeredRecovery(h, { jev: true });
  Object.defineProperty(r.ctx, "modelRegistry", {
    configurable: true,
    get() {
      throw Error("provider offline");
    },
  });
  const invalidate = vi.spyOn(EntryIndex.prototype, "invalidate");
  await r.run(args);
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
  expect(invalidate).toHaveBeenCalledWith(h.dir);
  expect(r.afterWrite).toHaveBeenCalledTimes(1);
  expect(r.afterWrite).toHaveBeenCalledWith("/", "revision");
});

it.each(["gate", "abort", "cas"])("last data-syscall %s race retains C intent and forbids retry", async (race) => {
  const { h, args, auditPath } = await committed();
  const r = await registeredRecovery(h);
  const after = fs.readFileSync(h.targetPath);
  const original = safeFs.replaceRevisionObserved;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[0] === h.blocks) {
      expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt.state).toBe("intent");
      if (race === "gate") r.state.gate = false;
      if (race === "abort") r.lifecycle.abort();
      if (race === "cas") fs.appendFileSync(h.targetPath, "external last-syscall edit");
    }
    return original(...args); // REAL adapter invokes C's beforeSyscall CAS, no fake result
  });
  await r.run(args);
  expect(fs.readFileSync(h.targetPath)).toEqual(
    race === "cas" ? Buffer.concat([after, Buffer.from("external last-syscall edit")]) : after,
  );
  expect(JSON.parse(fs.readFileSync(auditPath, "utf8")).restoreAttempt).toBeDefined();
  expect(r.afterWrite).toHaveBeenCalledTimes(1);
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("effect-unknown");
});

it("actual files layout refuses before C discovery even when settings say blocks", async () => {
  const { h, args } = await committed();
  const r = await registeredRecovery(h);
  fs.renameSync(h.blocks, join(h.dir, "preserved-blocks"));
  const bytes = treeBytes(h.dir);
  const preview = vi.spyOn(auditModule, "previewRevisionRestore");
  await r.run(args);
  expect(preview).not.toHaveBeenCalled();
  expect(r.ui.confirm).not.toHaveBeenCalled();
  expect(treeBytes(h.dir)).toEqual(bytes);
  expect(r.ui.notify.mock.calls.at(-1)?.[0]).toContain("actual blocks directory required");
});

it("actual blocks recovery does not require a configured blocks renderer or governance/auto/provider enablement", async () => {
  const { h, args, before } = await committed();
  const r = await registeredRecovery(h);
  r.settings.layout = "legacy";
  r.settings.incremental.enabled = false;
  expect(r.settings.governance.enabled).toBe(false);
  await r.run(args);
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
  expect(r.ui.confirm).toHaveBeenCalledTimes(1);
  expect(r.afterWrite).toHaveBeenCalledWith("/", "revision");
});
