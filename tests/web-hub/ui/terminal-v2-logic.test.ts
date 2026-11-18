import { describe, expect, it } from "vitest";
import type { TerminalQuotaV2 } from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
import {
  loadTerminalV2Restore,
  saveTerminalV2Restore,
  TERMINAL_V2_RESTORE_MS,
  terminalCanCreateV2,
  terminalViewFrameValueV2Ok,
  type TerminalRestoreStorageV2,
} from "../../../src/web-hub/ui/src/logic/terminal-v2.js";
import { hubV2, requestV2, scopeV2, termV2 } from "./terminal-v2-fixtures.js";

class Storage implements TerminalRestoreStorageV2 {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

const restore = {
  open: true,
  hubInstance: hubV2,
  activeTermId: termV2,
  pendingRequestIds: [requestV2],
};

describe("terminal v2 pure UI logic", () => {
  it("requires room in session, principal and total, with unknown still included", () => {
    const quota: TerminalQuotaV2 = {
      session: { used: 1, unknown: 1, limit: 2 },
      principal: { used: 1, unknown: 0, limit: 2 },
      total: { used: 1, unknown: 0, limit: 8 },
    };
    expect(terminalCanCreateV2(quota)).toBe(true);
    expect(terminalCanCreateV2({ ...quota, session: { ...quota.session, used: 2 } })).toBe(false);
    expect(terminalCanCreateV2({ ...quota, principal: { ...quota.principal, used: 2 } })).toBe(false);
    expect(terminalCanCreateV2({ ...quota, total: { ...quota.total, used: 8 } })).toBe(false);
  });

  it("stores only bounded non-secret intent/selection data and expires it", () => {
    const storage = new Storage();
    saveTerminalV2Restore(storage, scopeV2, restore, 100_000);
    expect(loadTerminalV2Restore(storage, scopeV2, 100_000)).toEqual(restore);
    expect(storage.value).not.toContain("bash");
    expect(storage.value).not.toContain("cwd");
    expect(storage.value).not.toContain("token");
    expect(loadTerminalV2Restore(storage, scopeV2, 100_000 + TERMINAL_V2_RESTORE_MS + 1)).toBeUndefined();
    expect(loadTerminalV2Restore(storage, { ...scopeV2, sessionId: "other" }, 100_000)).toBeUndefined();
  });

  it("keeps at most 32 recently saved scopes", () => {
    const storage = new Storage();
    for (let index = 0; index < 40; index++)
      saveTerminalV2Restore(storage, { ...scopeV2, sessionId: `session-${index}` }, restore, 100_000 + index);
    const rows = JSON.parse(storage.value ?? "[]") as unknown[];
    expect(rows).toHaveLength(32);
    expect(storage.value?.length).toBeLessThan(65_536);
    expect(loadTerminalV2Restore(storage, { ...scopeV2, sessionId: "session-39" }, 100_039)).toEqual(restore);
    expect(loadTerminalV2Restore(storage, { ...scopeV2, sessionId: "session-0" }, 100_039)).toBeUndefined();
  });

  it("fails closed for corrupt storage and semantic frame overflow", () => {
    const storage = new Storage();
    storage.value = "{broken";
    expect(loadTerminalV2Restore(storage, scopeV2, 100_000)).toBeUndefined();
    expect(terminalViewFrameValueV2Ok({ t: "output", offset: Number.MAX_SAFE_INTEGER, bytesB64: "YQ==" })).toBe(false);
    expect(terminalViewFrameValueV2Ok({ t: "gap", from: 2, to: 2 })).toBe(false);
  });
});
