import { expect, it } from "vitest";
import { projectOf } from "../../tiers.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog } from "./helpers.js";
import type { CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import { createCommandRouter } from "../../../src/web-hub/hub/commands.js";
it("v2 actual PTY/stream/hub tests are tier2, not secure-mount skipped", () => {
  for (const name of ["backend", "backend-crash", "stream", "hub"])
    expect(projectOf(`tests/integration/terminal-v2-${name}.test.ts`)).toBe("tier2");
});
it("T-CACHE hub defense-in-depth sanitizes reserved result BEFORE LRU/duplicate/query return", async () => {
  const registry = createRegistry({ now: () => 1000, log: memLog(), pidAlive: () => true });
  let agentKey = "";
  const registration = registry.register(hello({ caps: ["cmd.v1", "command.v1"] }), {
    send: (f) => {
      if (f.t !== "cmd") return;
      // Intentionally bypass ingress to exercise the second, router-local cache boundary.
      registry.onFrame(agentKey, {
        t: "cmd_result",
        id: f.id,
        rid: f.rid,
        ok: true,
        data: {
          op: "command",
          kind: "builtin",
          completion: "sync",
          history: "none",
          terminal: { v: 1, outcome: "handshake-required", offerId: "PRIVATE-MARKER" },
        },
      });
    },
    close() {},
  });
  agentKey = registration.agentKey;
  const router = createCommandRouter({ registry, log: memLog(), now: () => 1000 });
  const f: CmdFrame = {
    t: "cmd",
    rid: "rid",
    id: "a".repeat(16),
    deadlineMs: 2000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16) },
    cmd: { op: "command", name: "version", args: "" },
  };
  const first = await router.request(f, agentKey);
  expect(first).toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "unknown" });
  const duplicate = await router.request(f, agentKey),
    query = await router.request({ ...f, queryOnly: true }, agentKey);
  expect(JSON.stringify([first, duplicate, query])).not.toContain("PRIVATE-MARKER");
  expect(query).toMatchObject({
    ok: true,
    data: { op: "query", state: "failed", result: { ok: false, code: "E_UNSUPPORTED" } },
  });
});
