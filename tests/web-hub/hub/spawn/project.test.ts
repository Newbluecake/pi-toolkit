/**
 * web-hub-spawn plan §SP9 验收（#8 硬门槛的前半）：arch §6.4 字段可见性矩阵——对投影的
 * 每一行（字段）× 每一列（SSE Public / GET 非 owner / GET owner）逐格断言，外加
 * 「任何投影里都不出现首条消息正文」的负面断言（LAN 侧矩阵在
 * `tests/web-hub/http/lan-headless.test.ts` 覆盖）。
 */
import { describe, expect, it } from "vitest";
import type { InternalRecord } from "../../../../src/web-hub/hub/spawn/supervisor.js";
import { toPublic, toPublicPayload, toViewer } from "../../../../src/web-hub/hub/spawn/project.js";
import type { FirstPromptStateView } from "../../../../src/web-hub/hub/spawn/first-prompt.js";

/** The unique first-prompt body sentinel — must never survive into ANY projection. */
const PROMPT_BODY = "TOP-SECRET-FIRST-PROMPT-𝄞-body";

function makeRecord(partial: Partial<InternalRecord> & Pick<InternalRecord, "spawnId">): InternalRecord {
  return {
    state: "starting",
    cwd: "/home/alice/proj",
    dev: 10,
    ino: 20,
    createdAt: 111,
    updatedAt: 222,
    owner: { listener: "lan", reqId: "browser-id-0123456789", user: "u7" },
    pid: 4242,
    linked: true,
    control: undefined,
    sessionId: undefined,
    hintDetail: undefined,
    uiCancelled: [],
    stderrTail: () => undefined,
    removePending: false,
    ...partial,
  };
}

const view: FirstPromptStateView = { state: "sending", textLen: 96, attempts: 1 };
const fpOf = (spawnId: string): FirstPromptStateView | undefined => (spawnId === "s1" ? view : undefined);

const rich = makeRecord({
  spawnId: "s1",
  state: "failed",
  endReason: "spawn_error",
  exit: { code: null, signal: "SIGKILL", unconfirmed: true },
  hint: "protocol-error",
  hintDetail: "stderr said something private",
  agentKey: "agent-1",
  procStartTicks: 1234,
  bootId: "boot-1",
  uid: 1000,
  firstPrompt: { state: "pending", textLen: 96 },
  uiCancelled: [{ method: "select", title: "X".repeat(300), at: 5 }],
  stderrTail: () => "boom: /home/alice/secret-path",
});

const OWNER_PRINCIPAL = "lan:u7";
const OTHER_PRINCIPAL = "lan:u9";

describe("toPublic — the SSE/broadcast column (arch §6.4)", () => {
  it("carries exactly the lifecycle fields, never an owner-only field", () => {
    const p = toPublic(rich, fpOf);
    expect(p).toMatchObject({
      spawnId: "s1",
      state: "failed",
      createdAt: 111,
      updatedAt: 222,
      cwdLabel: "proj",
      pid: 4242,
      agentKey: "agent-1",
      linked: true,
      origin: { listener: "lan", reqId: "browser-id-0123456789" },
      endReason: "spawn_error",
      exit: { code: null, signal: "SIGKILL", unconfirmed: true },
      hint: "protocol-error",
      uiCancelledCount: 1,
      firstPrompt: { state: "sending" },
    });
    // §6.4's owner-only rows — column-by-column negatives:
    expect("cwd" in p).toBe(false); // full realpath
    expect("user" in p.origin).toBe(false); // origin.user
    expect("hintDetail" in p).toBe(false);
    expect("stderrTail" in p).toBe(false);
    expect("uiCancelled" in p).toBe(false); // only the COUNT is public
    expect(p.firstPrompt && "textLen" in p.firstPrompt).toBe(false);
    expect("procStartTicks" in p).toBe(false);
    expect("bootId" in p).toBe(false);
    expect("uid" in p).toBe(false);
    expect("stderrLog" in p).toBe(false);
  });

  it("firstPrompt code rides the public slice (state+code only, no textLen/attempts)", () => {
    const failed = makeRecord({
      spawnId: "s2",
      firstPrompt: { state: "pending", textLen: 5 },
    });
    const withCode: FirstPromptStateView = { state: "failed", code: "E_SESSION_CHANGED", textLen: 5, attempts: 2 };
    const p = toPublic(failed, () => withCode);
    expect(p.firstPrompt).toEqual({ state: "failed", code: "E_SESSION_CHANGED" });
  });

  it("no view supplied ⇒ falls back to the persisted slice's state", () => {
    const p = toPublic(rich);
    expect(p.firstPrompt).toEqual({ state: "pending" });
  });

  it("launching maps to starting (wire state honesty)", () => {
    const p = toPublic(makeRecord({ spawnId: "s3", state: "launching" }));
    expect(p.state).toBe("starting");
  });

  it("web-hub-delete-session plan v2 §2.2: removePending ⇒ removing:true; absent otherwise", () => {
    const removing = toPublic(makeRecord({ spawnId: "s-rm", state: "stopping", removePending: true }));
    expect(removing.removing).toBe(true);
    const notRemoving = toPublic(makeRecord({ spawnId: "s-keep", state: "stopping", removePending: false }));
    expect("removing" in notRemoving).toBe(false);
  });
});

describe("toViewer — the GET columns (arch §6.4)", () => {
  it("owner sees the full SpawnRecordOwner (cwd, origin.user, hintDetail, stderrTail, uiCancelled, firstPrompt lens)", () => {
    const v = toViewer(rich, OWNER_PRINCIPAL, false, fpOf);
    expect(v).toMatchObject({
      cwd: "/home/alice/proj",
      origin: { listener: "lan", reqId: "browser-id-0123456789", user: "u7" },
      hintDetail: "stderr said something private",
      stderrTail: "boom: /home/alice/secret-path",
      uiCancelled: [{ method: "select", title: "X".repeat(120), at: 5 }], // title truncated to 120
      firstPrompt: { state: "sending", textLen: 96, attempts: 1 },
    });
  });

  it("non-owner sees Public only — cwd hidden until the record is live-bound", () => {
    const v = toViewer(rich, OTHER_PRINCIPAL, false, fpOf);
    expect("cwd" in v).toBe(false); // failed record, not bound-live
    expect("hintDetail" in v).toBe(false);
    expect("stderrTail" in v).toBe(false);
    expect("uiCancelled" in v).toBe(false);
    expect(v.uiCancelledCount).toBe(1);
    expect("user" in v.origin).toBe(false);
    expect(v.firstPrompt && "textLen" in v.firstPrompt).toBe(false);
  });

  it("§6.4's exception row: a non-owner DOES see cwd once bound to a live card", () => {
    const live = makeRecord({ spawnId: "s4", state: "live", agentKey: "agent-2", control: true });
    const v = toViewer(live, OTHER_PRINCIPAL, false);
    expect("cwd" in v).toBe(true);
    // starting-with-agentKey is NOT yet a live card — still hidden
    const starting = makeRecord({ spawnId: "s5", state: "starting", agentKey: "agent-3" });
    expect("cwd" in toViewer(starting, OTHER_PRINCIPAL, false)).toBe(false);
  });

  it("loopback principals own every record (arch §6.0)", () => {
    const v = toViewer(rich, "loopback:token", true, fpOf);
    expect("cwd" in v).toBe(true);
    expect("stderrTail" in v).toBe(true);
  });

  it("stderrTail is owner-only AND failed-only", () => {
    const live = makeRecord({
      spawnId: "s6",
      state: "live",
      stderrTail: () => "noisy stderr",
    });
    expect("stderrTail" in toViewer(live, OWNER_PRINCIPAL, false)).toBe(false);
    const exited = makeRecord({ spawnId: "s7", state: "exited", stderrTail: () => "gone" });
    expect("stderrTail" in toViewer(exited, OWNER_PRINCIPAL, false)).toBe(false);
  });

  it("owner view without a forwarder view falls back to the persisted slice (textLen/attempts from disk)", () => {
    const v = toViewer(rich, OWNER_PRINCIPAL, false);
    expect(v.firstPrompt).toEqual({ state: "pending", textLen: 96, attempts: 0 });
  });

  it("web-hub-delete-session plan v2 §2.2: removing rides BOTH the owner and non-owner views", () => {
    const removingRec = makeRecord({ spawnId: "s-rm2", state: "stopping", removePending: true });
    expect(toViewer(removingRec, OWNER_PRINCIPAL, false).removing).toBe(true);
    expect(toViewer(removingRec, OTHER_PRINCIPAL, false).removing).toBe(true);
  });
});

describe("toPublicPayload — the SSE snapshot (D6: Public only)", () => {
  it("counts active over non-terminal records and copies cfg.max", () => {
    const recs = [
      rich,
      makeRecord({ spawnId: "sx", state: "live" }),
      makeRecord({ spawnId: "sy", state: "exited", endReason: "user" }),
      makeRecord({ spawnId: "sz", state: "launching" }),
    ];
    const payload = toPublicPayload(recs, 7, fpOf);
    expect(payload.max).toBe(7);
    expect(payload.active).toBe(2); // failed + exited excluded; live + launching(launching) counted
    expect(payload.items.map((i) => i.state)).toEqual(["failed", "live", "exited", "starting"]);
  });

  it("no record carries an owner-only field in the snapshot", () => {
    const payload = toPublicPayload([rich], 4, fpOf);
    for (const item of payload.items) {
      expect("cwd" in item).toBe(false);
      expect("hintDetail" in item).toBe(false);
      expect("stderrTail" in item).toBe(false);
    }
  });
});

describe("first-prompt body never survives any projection (arch §6.4/§4.6)", () => {
  it("the sentinel text appears in NO serialization of any projection or the fp view", () => {
    const recs = [rich, makeRecord({ spawnId: "s9", state: "live" })];
    const blob = JSON.stringify({
      public: recs.map((r) => toPublic(r, fpOf)),
      viewerOwner: toViewer(rich, OWNER_PRINCIPAL, false, fpOf),
      viewerOther: toViewer(rich, OTHER_PRINCIPAL, false, fpOf),
      payload: toPublicPayload(recs, 4, fpOf),
      view,
    });
    expect(blob).not.toContain(PROMPT_BODY);
    expect(blob).not.toContain("TOP-SECRET");
  });
});
