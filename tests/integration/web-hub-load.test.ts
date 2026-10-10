import { describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { HubLoadConfig } from "../../src/web-hub/hub/ports.js";
import { fakeDeps, login, openSse, rawRequest } from "../web-hub/http/helpers.js";
import { makeTmp } from "../web-hub/http/helpers.js";

const load: HubLoadConfig = {
  sampleIntervalMs: 5_000,
  sustainMs: 60_000,
  recoverMs: 30_000,
  thresholds: {
    cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
    mem: { warnAvailPercent: 15, critAvailPercent: 8 },
    disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
  },
};

describe("web-hub P3 load wiring", () => {
  it("authenticates before top scans and serves one host-load SSE snapshot", async () => {
    if (process.platform !== "linux") return;
    const tmp = makeTmp("pwh-load-");
    const deps = fakeDeps(tmp.dir);
    deps.config = { ...deps.config, load };
    const frontend = createHttpFrontend(deps);
    try {
      const port = (await frontend.listen()).port;
      const noHeader = await rawRequest(port, { path: "/api/load/top" });
      expect(noHeader.status).toBe(403);
      const cookie = await login(port, deps.paths.tokenFile);
      const top = await rawRequest(port, {
        path: "/api/load/top",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      expect(top.status).toBe(200);
      const body = JSON.parse(top.body) as { byCpu?: unknown[]; byRss?: unknown[] };
      expect(Array.isArray(body.byCpu)).toBe(true);
      expect(Array.isArray(body.byRss)).toBe(true);

      const sse = await openSse(port, { cookie });
      expect(sse.status).toBe(200);
      const frame = await sse.waitFor((event) => event.event === "load", 3_000);
      expect(frame.id).toBeUndefined();
      expect(frame.data).toMatchObject({ v: 1, scope: "host", intervalMs: load.sampleIntervalMs });
      sse.close();
    } finally {
      await frontend.close();
      tmp.cleanup();
    }
  });
});
