/**
 * Contract test ①（plan §11 表格）: every stub carved out by the W1 interface
 * package throws `E_NOT_IMPLEMENTED:<pkg>` (message includes the package
 * name) when called, and does nothing else observable. When W2/W3 fills in a
 * package, the corresponding `it(...)` below MUST be deleted — its continued
 * presence/pass would mean the stub was never replaced.
 */
import { describe, expect, it } from "vitest";
import { defaultLanAssembly } from "../../../src/web-hub/hub/lan-assembly.js";
import type { Scope } from "../../../src/web-hub/hub/lifecycle.js";
import type { HubLog } from "../../../src/web-hub/hub/ports.js";

const noopLog: HubLog = { info() {}, warn() {}, error() {} };

describe("W1 stubs throw E_NOT_IMPLEMENTED:<pkg> (contract ①)", () => {
  it("lan-assembly.ts: defaultLanAssembly.build ⇒ LD", async () => {
    await expect(
      defaultLanAssembly.build({
        cfg: { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
        paths: {} as never,
        log: noopLog,
        now: () => 0,
        scope: {} as Scope,
        onStatus: () => {},
      }),
    ).rejects.toThrow("E_NOT_IMPLEMENTED:LD");
  });
});
