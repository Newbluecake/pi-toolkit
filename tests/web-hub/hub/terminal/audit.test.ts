import { describe, it, expect } from "vitest";
import { auditTerminal } from "../../../../src/web-hub/hub/audit.js";
describe("terminal audit §11", () => {
  it("only fixed tokens/counters survive untyped inputs, never nested content or content hashes", () => {
    const out: object[] = [];
    const log = { info: (_m: string, data?: object) => out.push(data!) };
    auditTerminal(log, {
      op: "input",
      ok: true,
      listener: "lan",
      bytesIn: 3,
      bytesOut: 4,
      ms: 5,
      cwd: "secret-marker",
      stdin: "secret-marker",
      stdout: "secret-marker",
      hash: "secret-marker",
      writerLease: "secret-marker",
      nonce: "secret-marker",
      grant: "secret-marker",
    } as never);
    expect(out).toEqual([
      { audit: "terminal", op: "input", ok: true, listener: "lan", bytesIn: 3, bytesOut: 4, ms: 5 },
    ]);
    auditTerminal(log, {
      op: "secret-marker",
      ok: { secret: "marker" },
      listener: { secret: "marker" },
      bytesIn: { secret: "marker" },
      code: "secret-marker",
      reap: { secret: "marker" },
    } as never);
    expect(out[1]).toEqual({ audit: "terminal" });
  });
  it("a failing logger reports failure without throwing into the control/reaper path", () => {
    expect(
      auditTerminal(
        {
          info() {
            throw Error("disk");
          },
        },
        { op: "close", ok: true },
      ),
    ).toBe(false);
  });
});
