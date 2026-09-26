import { describe, expect, it } from "vitest";
import * as proto from "../../../src/web-hub/protocol/http-contract.js";
import * as web from "../../../src/web-hub/web/contract.js";
import { initialState, reduce } from "../../../src/web-hub/web/state.js";
import { createClient } from "../../../src/web-hub/web/app.js";

describe("web/contract.js mirrors protocol/http-contract.ts", () => {
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
