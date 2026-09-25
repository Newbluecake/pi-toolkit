/**
 * Contract test ①（plan §11 表格）: every stub carved out by the W1 interface
 * package throws `E_NOT_IMPLEMENTED:<pkg>` (message includes the package
 * name) when called, and does nothing else observable. When W2/W3 fills in a
 * package, the corresponding `it(...)` below MUST be deleted — its continued
 * presence/pass would mean the stub was never replaced.
 */
import { describe, expect, it } from "vitest";
import { buildContext, createLanTransport } from "../../../src/web-hub/hub/http.js";
import { defaultLanAssembly } from "../../../src/web-hub/hub/lan-assembly.js";
import type { Scope } from "../../../src/web-hub/hub/lifecycle.js";
import type { HubLog } from "../../../src/web-hub/hub/ports.js";
import {
  TMP_SOCKET_DIR_POLICY,
  XDG_SOCKET_DIR_POLICY,
  ensurePrivateDir,
  verifyBoundSocket,
} from "../../../src/web-hub/protocol/paths.js";

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

  it('http.ts: buildContext(req, "lan") ⇒ LC', () => {
    expect(() => buildContext({ headers: {}, socket: {} } as never, "lan")).toThrow("E_NOT_IMPLEMENTED:LC");
  });

  it("http.ts: createLanTransport(...) ⇒ LC", () => {
    expect(() => createLanTransport({ handleRequest: async () => {}, log: noopLog, connGuard: undefined })).toThrow(
      "E_NOT_IMPLEMENTED:LC",
    );
  });

  it("protocol/paths.ts: ensurePrivateDir(dir, XDG_SOCKET_DIR_POLICY) ⇒ LP", async () => {
    await expect(ensurePrivateDir("/run/user/1000", XDG_SOCKET_DIR_POLICY)).rejects.toThrow("E_NOT_IMPLEMENTED:LP");
  });

  it("protocol/paths.ts: ensurePrivateDir(dir, TMP_SOCKET_DIR_POLICY) ⇒ LP", async () => {
    await expect(ensurePrivateDir("/tmp/pi-webhub-1000", TMP_SOCKET_DIR_POLICY)).rejects.toThrow(
      "E_NOT_IMPLEMENTED:LP",
    );
  });

  it("protocol/paths.ts: verifyBoundSocket(...) ⇒ LP", async () => {
    await expect(verifyBoundSocket("/tmp/x/hub.sock", { dev: 0, ino: 0 })).rejects.toThrow("E_NOT_IMPLEMENTED:LP");
  });
});
