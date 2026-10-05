import { describe, expect, it } from "vitest";
import * as proto from "../../../src/web-hub/protocol/http-contract.js";
import * as previewProto from "../../../src/web-hub/protocol/preview.js";
import * as uploadProto from "../../../src/web-hub/protocol/upload.js";
import * as web from "../../../src/web-hub/ui/src/logic/contract.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { createClient } from "../../../src/web-hub/ui/src/logic/token-client.js";

describe("web/contract.js mirrors protocol/http-contract.ts", () => {
  it("SSE_EVENTS is the same array reference as protocol/http-contract.ts's (P5b \u6253\u56de\u70b9 4: imported, not copied)", () => {
    expect(web.SSE_EVENTS).toBe(proto.SSE_EVENTS);
  });

  it("API_ERRORS is the same array reference as protocol/http-contract.ts's (P5b \u6253\u56de\u70b9 4: imported, not copied)", () => {
    expect(web.API_ERRORS).toBe(proto.API_ERRORS);
  });

  it("SSE_EVENTS deep-equal (same names, same order)", () => {
    expect([...web.SSE_EVENTS]).toEqual([...proto.SSE_EVENTS]);
  });

  it("API_ERRORS deep-equal", () => {
    expect([...web.API_ERRORS]).toEqual([...proto.API_ERRORS]);
  });

  it("mirrored arrays are frozen", () => {
    expect(Object.isFrozen(web.SSE_EVENTS)).toBe(true);
    expect(Object.isFrozen(web.API_ERRORS)).toBe(true);
  });

  // LC review fix (lan-plan.md §15.9 #6, additive exception): `API.session`/`API.logout` are
  // LAN-only endpoints that have no counterpart in `protocol/http-contract.ts` (no `API` export
  // there to mirror against), so nothing above catches a typo/rename in either literal.
  it("API.session and API.logout point at the S1 LAN-only endpoints", () => {
    expect(web.API.session).toBe("/api/session");
    expect(web.API.logout).toBe("/api/logout");
  });

  // U4b (web-hub-upload plan §1.2): the four upload endpoints are imported from
  // `protocol/upload.ts` — same anti-drift rule as SSE_EVENTS/API_ERRORS (same reference
  // target), pinned against BOTH the protocol constants and the §1.2 literals.
  it("API's upload endpoints are the protocol module's frozen paths (U4b §1.2)", () => {
    expect(web.API.uploadBegin).toBe(uploadProto.UPLOAD_BEGIN_PATH);
    expect(web.API.uploadChunk).toBe(uploadProto.UPLOAD_CHUNK_PATH);
    expect(web.API.uploadCommit).toBe(uploadProto.UPLOAD_COMMIT_PATH);
    expect(web.API.uploadAbort).toBe(uploadProto.UPLOAD_ABORT_PATH);
    expect(web.API.uploadBegin).toBe("/api/upload/begin");
    expect(web.API.uploadChunk).toBe("/api/upload/chunk");
    expect(web.API.uploadCommit).toBe("/api/upload/commit");
    expect(web.API.uploadAbort).toBe("/api/upload/abort");
  });

  // PV4 (web-hub-preview plan v3 §4.1): the preview endpoint is imported from
  // `protocol/preview.ts` — same anti-drift rule as the upload endpoints above.
  it("API.preview is the protocol module's frozen PREVIEW_PATH (PV4 §4.1)", () => {
    expect(web.API.preview).toBe(previewProto.PREVIEW_PATH);
    expect(web.API.preview).toBe("/api/preview");
  });

  it("reduce accepts every SSE event name without throwing (minimal / garbage payloads)", () => {
    for (const name of proto.SSE_EVENTS) {
      for (const data of [undefined, null, {}, [], "x", { agentKey: "nope" }]) {
        expect(() => reduce(initialState(), { event: name, data })).not.toThrow();
      }
    }
  });

  it("the client registers a listener for every SSE event name on its single EventSource", () => {
    const created: Array<{ names: Set<string> }> = [];
    class FakeES {
      readyState = 0;
      names = new Set<string>();
      constructor() {
        created.push(this);
      }
      addEventListener(name: string) {
        this.names.add(name);
      }
      close() {}
    }
    const client = createClient({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      EventSource: FakeES,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => 0,
      onMessage: () => {},
      onConn: () => {},
    });
    return client.start().then(() => {
      expect(created).toHaveLength(1);
      for (const name of proto.SSE_EVENTS) expect(created[0]!.names.has(name), name).toBe(true);
      client.close();
    });
  });
});

describe("web/contract.js API headless endpoints (web-hub-spawn SP11 / arch §8.2)", () => {
  // `protocol/spawn.ts` (SP1) freezes the body/record TYPES but has no path constants, so
  // these two literals are hand-written (same situation as API.session/API.logout above) —
  // pin them against arch §8.2's route table here.
  it("API.headless and API.headlessDirs point at the arch §8.2 endpoints", () => {
    expect(web.API.headless).toBe("/api/headless");
    expect(web.API.headlessDirs).toBe("/api/headless/dirs");
  });

  it("reduce tolerates a valid spawns frame (registered SSE event, overwrite slot)", () => {
    const s = reduce(initialState(), {
      event: "spawns",
      data: { items: [{ spawnId: "sp1", state: "starting" }], active: 1, max: 4 },
    });
    expect(s.spawns).toEqual({ items: [{ spawnId: "sp1", state: "starting" }], active: 1, max: 4 });
  });
});

// web-hub-fleet-drawer plan §3.1/§3.2/§3.4 (F0): the run-transcript browser surface.
describe("web/contract.js run-transcript surface (fleet-drawer F0)", () => {
  it("API.run* literals are pinned against protocol RUN_API both ways (hand-written mirror)", async () => {
    const runTx = await import("../../../src/web-hub/protocol/run-transcript.js");
    expect(web.API.runSubscribe).toBe(runTx.RUN_API.subscribe);
    expect(web.API.runUnsubscribe).toBe(runTx.RUN_API.unsubscribe);
    expect(web.API.runHistory).toBe(runTx.RUN_API.history);
    expect(web.API.runSubscribe).toBe("/api/run/subscribe");
    expect(web.API.runUnsubscribe).toBe("/api/run/unsubscribe");
    expect(web.API.runHistory).toBe("/api/run/history");
  });

  it("SSE_EVENTS carries the three run events (the browser mirror is the same array)", () => {
    for (const name of ["run_history", "run_ev", "run_end"]) {
      expect(proto.SSE_EVENTS).toContain(name);
      expect(web.SSE_EVENTS).toContain(name);
    }
  });

  it("the F5-era reducer ignores run_* events identity-wise (compat matrix row 3: old reducers drop unknown events)", () => {
    const s = initialState();
    expect(reduce(s, { event: "run_history", data: { agentKey: "a", runId: "r_ABCD1234", entries: [] } })).toBe(s);
    expect(
      reduce(s, {
        event: "run_ev",
        data: { agentKey: "a", runId: "r_ABCD1234", tapId: "t", seq: 1, e: { type: "message_end" } },
      }),
    ).toBe(s);
    expect(
      reduce(s, { event: "run_end", data: { agentKey: "a", runId: "r_ABCD1234", lastSeq: 1, status: "ok" } }),
    ).toBe(s);
    expect(reduce(s, { event: "run_history", data: { error: "E_BUSY", reason: "resync_storm" } })).toBe(s);
  });
});
