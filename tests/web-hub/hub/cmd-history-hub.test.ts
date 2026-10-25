import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type {
  AgentFrame,
  CmdFrame,
  CmdOrigin,
  HubFrame,
  SnapshotReplyBody,
  WireEntry,
} from "../../../src/web-hub/protocol/messages.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import { createCommandRouter } from "../../../src/web-hub/hub/commands.js";
import { createHistoryService } from "../../../src/web-hub/hub/history.js";
import { createRegistry, type AgentConn, type Registry } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog, recordBus, tmpDirs, waitFor } from "./helpers.js";

/**
 * cmd-history H1 §8.3 (m8②) — the 56c71cae regression pin.
 *
 * The record pipeline's write path (appendEntry → agent 1 Hz tick → `status` leafId change →
 * hub `runTail`, including H1's §4.10 ENOENT branch fallback) now publishes `append` frames on
 * the SAME registry bus the command ledger lives behind. This pins that none of that churn can
 * touch the ledger's post-56c71cae settlement semantics:
 *  - an extension command answered `completion:"unknown"` (agent_settled-deferred dispatch — the
 *    capture window never opened) with NO `cmd_late` ever arriving stays cached exactly as the
 *    agent answered it (done / byte-equal body), never flipped to running, never fabricated
 *    output, and a later queryOnly is served from the cache without a new `cmd` frame;
 *  - a `completion:"async"` command still upgrades through `cmd_late` under the same churn.
 */

const tmp = tmpDirs();

interface Rig {
  reg: Registry;
  events: HubEvent[];
  agentKey: string;
  conn: { sent: HubFrame[] };
  router: ReturnType<typeof createCommandRouter>;
  history: ReturnType<typeof createHistoryService>;
  log: ReturnType<typeof memLog>;
  branchWith: (entries: WireEntry[]) => void;
  status: (leafId: string, busy?: boolean) => void;
  appends: () => WireEntry[][];
  dispose: () => void;
}

const iso = (): string => new Date(1_790_000_000_000).toISOString();
/** Deterministic per-id timestamp ⇒ distinct `role:timestamp` diff keys per entry. */
const tsOf = (id: string): number => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 100_000;
  return 1_000 + h;
};
const entry = (id: string, parentId: string | null): WireEntry => ({
  id,
  parentId,
  type: "message",
  timestamp: iso(),
  message: { role: "user", timestamp: tsOf(id), content: id },
});

function rig(): Rig {
  const clock = { t: 1_000_000 };
  const log = memLog();
  const reg = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const events = recordBus(reg);
  const sent: HubFrame[] = [];
  let branch: WireEntry[] = [entry("m1", null), entry("m2", "m1")];
  const leafAtStart = "m2";
  // persisted session path, never created on disk (the §4.10 pre-first-message window)
  const sessionFile = join(tmp.make("wh-cmdhist-ledger-"), "session.jsonl");
  let key = "";
  const conn: AgentConn = {
    send(f) {
      sent.push(f);
      if (f.t === "snapshot_req") {
        const body: AgentFrame = {
          t: "snapshot_reply",
          rid: f.rid,
          seq: 10,
          leafId: leafAtStart,
          sessionFile, // persisted path, never created (§4.10 window)
          recent: [],
          prompts: [],
          status: { leafId: leafAtStart, busy: false, pending: false },
          fleet: [],
        };
        queueMicrotask(() => reg.onFrame(key, body));
      }
      if (f.t === "branch_req") {
        queueMicrotask(() => reg.onFrame(key, { t: "branch_reply", rid: f.rid, entries: branch, truncated: false }));
      }
      // `cmd` frames are answered manually by the test (the deferred-command scenario).
    },
    close() {},
  };
  key = reg.register(hello({ caps: ["ev.v1", "cmd.v1", "command.v1"] }), conn).agentKey;
  reg.onFrame(key, {
    t: "session",
    sessionId: "s",
    sessionFile,
    cwd: "/tmp/w",
    reason: "startup",
    leafId: leafAtStart,
    mode: "tui",
  });
  events.length = 0;
  const router = createCommandRouter({ registry: reg, log, now: () => clock.t });
  const history = createHistoryService({ registry: reg, log });
  return {
    reg,
    events,
    agentKey: key,
    conn: { sent },
    router,
    history,
    log,
    branchWith: (entries) => {
      branch = entries;
    },
    status: (leafId, busy = false) => {
      reg.onFrame(key, { t: "status", leafId, busy, pending: false });
    },
    appends: () => events.flatMap((e) => (e.type === "append" ? [e.entries] : [])),
    dispose: () => history.dispose(),
  };
}

function cmdFrame(id: string): CmdFrame {
  const origin: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16) };
  return {
    t: "cmd",
    rid: "",
    id,
    deadlineMs: 5_000,
    origin,
    cmd: { op: "command", name: "record", args: "on" },
  };
}

/** The agent's answer to the LAST sent `cmd` frame (manual — the deferred-command scenario). */
function answerCmd(r: Rig, body: object): void {
  const last = r.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as { rid: string; id: string };
  r.reg.onFrame(r.agentKey, { t: "cmd_result", rid: last.rid, id: last.id, ...body } as never);
}

describe("cmd-history H1 §8.3 (m8②) — 56c71cae ledger pin under record-driven tail appends", () => {
  it("completion:'unknown' with NO cmd_late stays settled while ENOENT-fallback appends and status churn flow through the same bus", async () => {
    const r = rig();
    await r.history.snapshot(r.agentKey); // baseline m1,m2 (via branch_req — the file does not exist yet)
    r.conn.sent.length = 0;
    r.events.length = 0;

    // 1. Web command; the agent_settled window deferred it, the capture window never opened ⇒
    //    the bridge answers completion:"unknown" and (this is the bug class of §1.1-3) NO
    //    cmd_late will ever arrive.
    const frame = cmdFrame("d".repeat(16));
    const p = r.router.request(frame, r.agentKey);
    answerCmd(r, { ok: true, data: { op: "command", kind: "extension", completion: "unknown", captured: true } });
    await expect(p).resolves.toMatchObject({ ok: true, data: { completion: "unknown" } });

    // 2. The command DID run: a subagent:cmd record lands in the agent's in-memory branch, the
    //    1 Hz tick reports the new leaf, and the hub's §4.10 ENOENT fallback publishes it live.
    r.branchWith([entry("m1", null), entry("m2", "m1"), entry("rec1", "m2")]);
    r.status("rec1");
    await waitFor(() => r.appends().length === 1, 3000);
    expect(r.appends()[0]!.map((e) => e.id)).toEqual(["rec1"]);

    // 3. More churn: another leaf change + append, and a busy flip with the same leaf.
    r.branchWith([entry("m1", null), entry("m2", "m1"), entry("rec1", "m2"), entry("rec2", "rec1")]);
    r.status("busy-flip", true);
    r.status("rec2");
    await waitFor(() => r.appends().length === 2, 3000);

    // 4. The ledger: none of that touched the cmd entry — a queryOnly is served from the cache,
    //    byte-equal to the agent's unknown answer, with NO new cmd frame sent.
    const cmdFramesBefore = r.conn.sent.filter((f) => (f as { t: string }).t === "cmd").length;
    const q = await r.router.request({ ...frame, queryOnly: true }, r.agentKey);
    expect(q).toMatchObject({
      ok: true,
      data: {
        op: "query",
        state: "ok",
        result: { ok: true, data: { op: "command", kind: "extension", completion: "unknown", captured: true } },
      },
    });
    expect(r.conn.sent.filter((f) => (f as { t: string }).t === "cmd").length).toBe(cmdFramesBefore);
    r.dispose();
  });

  it("completion:'async' still upgrades through cmd_late under the same record-driven churn (56c71cae semantics intact)", async () => {
    const r = rig();
    await r.history.snapshot(r.agentKey);
    r.conn.sent.length = 0;
    r.events.length = 0;

    const frame = cmdFrame("e".repeat(16));
    const p = r.router.request(frame, r.agentKey);
    answerCmd(r, { ok: true, data: { op: "command", kind: "extension", completion: "async", captured: true } });
    await expect(p).resolves.toMatchObject({ ok: true, data: { completion: "async" } });

    // record-driven appends flow while the entry is still "unknown"
    r.branchWith([entry("m1", null), entry("m2", "m1"), entry("rec1", "m2")]);
    r.status("rec1");
    await waitFor(() => r.appends().length === 1, 3000);

    // the late result upgrades the entry with the captured output
    r.reg.onFrame(r.agentKey, {
      t: "cmd_late",
      id: frame.id,
      op: "command",
      at: 1_000_001,
      ok: true,
      data: {
        op: "command",
        kind: "extension",
        completion: "sync",
        captured: true,
        output: { entries: [{ kind: "notify", level: "info", text: "recording on" }] },
      },
    } as never);

    const cmdFramesBefore = r.conn.sent.filter((f) => (f as { t: string }).t === "cmd").length;
    const q = await r.router.request({ ...frame, queryOnly: true }, r.agentKey);
    expect(q).toMatchObject({
      ok: true,
      data: {
        op: "query",
        state: "ok",
        result: {
          ok: true,
          data: { completion: "sync", captured: true, output: { entries: [{ kind: "notify", text: "recording on" }] } },
        },
      },
    });
    expect(r.conn.sent.filter((f) => (f as { t: string }).t === "cmd").length).toBe(cmdFramesBefore);
    r.dispose();
  });
});
