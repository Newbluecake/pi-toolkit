// @vitest-environment node
/**
 * worktree-diff plan v3.1 §5 D5 — `composables/useWorktreeDiff.ts` (§4.5): abort rules
 * (same-wt supersede, collapse-abort-keep-data, dialog supersede/close, scope invalidation),
 * the 409 `E_STALE_CTX` branch (auto re-pull the list ⇒ entry still present ⇒ retry the file
 * EXACTLY ONCE with the fresh base; entry gone ⇒ 不可查看; a second 409 ⇒ 不可查看, never a
 * loop), and D13's refresh rules (expanded-row sig change ⇒ debounced re-pull; the open
 * dialog's row sig change ⇒ stale banner ONLY, never an automatic re-fetch).
 */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorktreeDiff,
  type DialogState,
  type UseWorktreeDiffHandle,
} from "../../../src/web-hub/ui/src/composables/useWorktreeDiff.js";
import type { WorktreeDiffTransport } from "../../../src/web-hub/ui/src/transport/types.js";
import type { WtDiffFileList, WtDiffFilePayload } from "../../../src/web-hub/protocol/worktree-diff.js";
import type { WorktreeRowWire } from "../../../src/web-hub/protocol/messages.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

const row = (over: Partial<WorktreeRowWire> = {}): WorktreeRowWire =>
  ({ label: "~/w", path: "/wt/main", dirty: 3, head: "h1", ...over }) as WorktreeRowWire;

const list = (over: Partial<WtDiffFileList> = {}): WtDiffFileList => ({
  base: OID_A,
  entries: [
    { path: "src/a.ts", status: "M", add: 1, del: 2 },
    { path: "src/gone.ts", status: "D", del: 5 },
  ],
  total: 2,
  truncated: false,
  limits: { status: false, files: false, bytes: false },
  ...over,
});

const payload = (over: Partial<WtDiffFilePayload> = {}): WtDiffFilePayload => ({
  base: OID_A,
  path: "src/a.ts",
  kind: "patch",
  patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  bytes: 70,
  truncated: false,
  ...over,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const scopeRef = () => ref<{ agentKey: string; sessionId: string } | null>({ agentKey: "a1", sessionId: "s1" });

type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string; reason?: string };

function makeHandle(transport: WorktreeDiffTransport): UseWorktreeDiffHandle {
  return useWorktreeDiff({ transport, scope: scopeRef() });
}

describe("useWorktreeDiff — abort rules (§4.5)", () => {
  it("expanding pulls once; collapsing keeps the data and never re-pulls", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const h = makeHandle({ files, file: vi.fn() } as unknown as WorktreeDiffTransport);
    const r = row();

    h.toggleRow(r); // expand
    expect(files).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.lists.get("/wt/main")?.phase).toBe("ok");

    h.toggleRow(r); // collapse
    expect(files).toHaveBeenCalledTimes(1); // 收起不重拉
    expect(h.isExpanded("/wt/main")).toBe(false);
    expect(h.lists.get("/wt/main")?.phase).toBe("ok"); // data kept

    h.toggleRow(r); // re-expand
    expect(files).toHaveBeenCalledTimes(1); // still exactly one pull
    expect(h.isExpanded("/wt/main")).toBe(true);
    h.dispose();
  });

  it("collapsing aborts the in-flight list pull (the loser's settle is dropped)", async () => {
    const d = deferred<Outcome<WtDiffFileList>>();
    const files = vi.fn(() => d.promise);
    const h = makeHandle({ files, file: vi.fn() } as unknown as WorktreeDiffTransport);
    const r = row();

    h.toggleRow(r);
    const signal = files.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    h.toggleRow(r); // collapse while in flight
    expect(signal.aborted).toBe(true);
    expect(h.lists.get("/wt/main")?.phase).toBe("loading"); // stays loading, settle dropped

    d.resolve({ ok: true, value: list() }); // the aborted fetch settles late
    await flush();
    expect(h.lists.get("/wt/main")?.phase).toBe("loading"); // superseded — never lands
    h.dispose();
  });

  it("a new pull for the same wt aborts the previous one", async () => {
    const d1 = deferred<Outcome<WtDiffFileList>>();
    const files = vi
      .fn()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(async () => ({ ok: true, value: list() }));
    const h = makeHandle({ files, file: vi.fn() } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    const s1 = files.mock.calls[0]?.[1]?.signal as AbortSignal;
    h.refreshList("/wt/main");
    expect(s1.aborted).toBe(true);
    await flush();
    expect(h.lists.get("/wt/main")?.phase).toBe("ok");
    h.dispose();
  });

  it("openFile supersedes the in-flight dialog fetch; closeDialog aborts it", async () => {
    const d = deferred<Outcome<WtDiffFilePayload>>();
    const file = vi.fn(() => d.promise);
    const h = makeHandle({
      files: vi.fn(async () => ({ ok: true, value: list() })),
      file,
    } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    const s1 = file.mock.calls[0]?.[1]?.signal as AbortSignal;

    h.openFile("/wt/main", { path: "src/gone.ts", status: "D" });
    expect(s1.aborted).toBe(true); // superseded by the new open

    const s2 = file.mock.calls[1]?.[1]?.signal as AbortSignal;
    h.closeDialog();
    expect(s2.aborted).toBe(true);
    expect(h.dialog.value.phase).toBe("closed");
    h.dispose();
  });

  it("scope → null clears lists, expansion and the dialog, aborting everything in flight", async () => {
    const scope = scopeRef();
    const d = deferred<Outcome<WtDiffFilePayload>>();
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const file = vi.fn(() => d.promise);
    const h = useWorktreeDiff({ transport: { files, file } as unknown as WorktreeDiffTransport, scope });

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    const fileSignal = file.mock.calls[0]?.[1]?.signal as AbortSignal;

    scope.value = null;
    await flush();
    expect(h.lists.size).toBe(0);
    expect(h.expanded.size).toBe(0);
    expect(h.dialog.value.phase).toBe("closed");
    expect(fileSignal.aborted).toBe(true);
    h.dispose();
  });
});

describe("useWorktreeDiff — 409 E_STALE_CTX (§4.5, 恰好一次)", () => {
  it("base 409 ⇒ auto re-pull the list ⇒ entry still there ⇒ retry once with the new base", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const file = vi
      .fn()
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: false,
        status: 409,
        error: "E_STALE_CTX",
        reason: "base",
      }))
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: true,
        value: payload({ base: OID_B }),
      }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush(24); // 409 settle → re-pull list → retry file → settle

    expect(files).toHaveBeenCalledTimes(2); // expand + the stale re-pull
    expect(file).toHaveBeenCalledTimes(2); // original + exactly one retry
    const retryReq = file.mock.calls[1]?.[0] as { base: string };
    expect(retryReq.base).toBe(OID_A); // the re-pulled list's fresh base
    const d = h.dialog.value as Extract<DialogState, { phase: "ok" }>;
    expect(d.phase).toBe("ok");
    expect(d.payload?.base).toBe(OID_B);
    h.dispose();
  });

  it("entry 409 with the entry gone from the re-pulled list ⇒ the 不可查看 state", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({
      ok: true,
      value: list({ entries: [{ path: "src/other.ts", status: "M" }] }),
    }));
    const file = vi.fn(async (): Promise<Outcome<WtDiffFilePayload>> => ({
      ok: false,
      status: 409,
      error: "E_STALE_CTX",
      reason: "entry",
    }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush(24);

    expect(file).toHaveBeenCalledTimes(1); // never retried — the entry is gone
    const d = h.dialog.value as Extract<DialogState, { phase: "error" }>;
    expect(d.phase).toBe("error");
    expect(d.unviewable).toBe(true);
    h.dispose();
  });

  it("openFile for another file of the SAME wt during the stale re-pull is not overwritten (D5 验收 P1)", async () => {
    const filesFirst = deferred<Outcome<WtDiffFileList>>();
    const repull = deferred<Outcome<WtDiffFileList>>();
    let filesCalls = 0;
    const files = vi.fn(() => {
      filesCalls++;
      return filesCalls === 1 ? filesFirst.promise : repull.promise;
    });
    const file = vi
      .fn()
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: false,
        status: 409,
        error: "E_STALE_CTX",
        reason: "base",
      }))
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: true,
        value: payload({ path: "src/b.ts", base: OID_B }),
      }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    filesFirst.resolve({
      ok: true,
      value: list({
        entries: [
          { path: "src/a.ts", status: "M", add: 1, del: 2 },
          { path: "src/b.ts", status: "M", add: 3, del: 0 },
        ],
        total: 2,
      }),
    });
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush(8); // file A settles 409 → settleAfterStale starts; its list re-pull is now pending
    expect(files).toHaveBeenCalledTimes(2);

    // the user clicks file B of the SAME worktree while the stale re-pull is in flight
    h.openFile("/wt/main", { path: "src/b.ts", status: "M" });
    await flush(8);
    expect(file).toHaveBeenCalledTimes(2); // A's 409 + B's open

    repull.resolve({ ok: true, value: list({ base: OID_B }) });
    await flush(24);

    // without the seq guard, settleAfterStale would have overwritten B with A's retry
    expect(file).toHaveBeenCalledTimes(2); // no A retry after the supersede
    const d = h.dialog.value as Extract<DialogState, { phase: "ok" }>;
    expect(d.phase).toBe("ok");
    expect(d.payload?.path).toBe("src/b.ts");
    h.dispose();
  });

  it("a second 409 after the one retry settles as 不可查看 — never a loop", async () => {
    let filesCalls = 0;
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => {
      filesCalls++;
      // the re-pulled list still carries the entry, but the hub keeps answering 409
      return { ok: true, value: list({ base: filesCalls > 1 ? OID_B : OID_A }) };
    });
    const file = vi.fn(async (): Promise<Outcome<WtDiffFilePayload>> => ({
      ok: false,
      status: 409,
      error: "E_STALE_CTX",
      reason: "base",
    }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush(24);

    expect(file).toHaveBeenCalledTimes(2); // original + exactly one retry
    expect(files).toHaveBeenCalledTimes(2);
    const d = h.dialog.value as Extract<DialogState, { phase: "error" }>;
    expect(d.phase).toBe("error");
    expect(d.unviewable).toBe(true);
    h.dispose();
  });

  it("refreshDialog re-arms the one-shot retry (manual path, §4.5 同上分支)", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const file = vi
      .fn()
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: false,
        status: 409,
        error: "E_STALE_CTX",
        reason: "base",
      }))
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: true,
        value: payload({ base: OID_B }),
      }))
      .mockImplementationOnce(async (): Promise<Outcome<WtDiffFilePayload>> => ({
        ok: true,
        value: payload(),
      }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush(24);
    expect(h.dialog.value.phase).toBe("ok");

    h.refreshDialog(); // manual: pull list again, re-load the file
    await flush(24);
    expect(files).toHaveBeenCalledTimes(3); // expand + stale re-pull + manual re-pull
    expect(file).toHaveBeenCalledTimes(3); // original + one retry + the manual re-load
    h.dispose();
  });
});

describe("useWorktreeDiff — D13 refresh rules (§4.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an expanded row's sig change re-pulls after the 3 s debounce; within the window further changes reset it (one pull)", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const h = makeHandle({ files, file: vi.fn() } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    expect(files).toHaveBeenCalledTimes(1);

    h.onRowsChanged([row({ dirty: 4 })]);
    await vi.advanceTimersByTimeAsync(1_000);
    h.onRowsChanged([row({ dirty: 5 })]); // resets the window
    await vi.advanceTimersByTimeAsync(2_000);
    expect(files).toHaveBeenCalledTimes(1); // still inside the restarted window
    await vi.advanceTimersByTimeAsync(1_100);
    expect(files).toHaveBeenCalledTimes(2); // one debounced re-pull, not two
    h.dispose();
  });

  it("a collapsed row's sig change never re-pulls", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const h = makeHandle({ files, file: vi.fn() } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.toggleRow(row()); // collapse (data kept)
    h.onRowsChanged([row({ dirty: 9 })]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(files).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("the open dialog's row sig change raises ONLY the stale banner — no automatic fetches", async () => {
    const files = vi.fn(async (): Promise<Outcome<WtDiffFileList>> => ({ ok: true, value: list() }));
    const file = vi.fn(async (): Promise<Outcome<WtDiffFilePayload>> => ({ ok: true, value: payload() }));
    const h = makeHandle({ files, file } as unknown as WorktreeDiffTransport);

    h.toggleRow(row());
    await flush();
    h.openFile("/wt/main", { path: "src/a.ts", status: "M" });
    await flush();
    expect(h.dialog.value.phase).toBe("ok");

    const filesBefore = files.mock.calls.length;
    const fileBefore = file.mock.calls.length;
    h.onRowsChanged([row({ dirty: 7 })]);
    await vi.advanceTimersByTimeAsync(4_000);

    const d = h.dialog.value as Extract<DialogState, { phase: "ok" }>;
    expect(d.stale).toBe(true); // the banner
    // ... and the DIALOG's own fetch never re-fires. (The row is still EXPANDED, so D13's
    // debounced LIST re-pull is expected — files() may re-fire; file() must not.)
    expect(file.mock.calls.length).toBe(fileBefore);
    expect(files.mock.calls.length).toBeGreaterThan(filesBefore);
    h.dispose();
  });
});
