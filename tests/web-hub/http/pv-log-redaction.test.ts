/**
 * web-hub HTML preview (plan v2 §2.6, T-H15) — the three HTTP fallback error logs
 * (`hub/http.ts`: loopback `onRequest`, LAN `handleLanRequest`, LAN listener `.catch`) must never
 * carry a `/pv/<cap>/…` / `/pvw/<cap>` URL (the cap is the credential) nor an fs error MESSAGE
 * (it carries paths): `url` ⇒ `/pv/[redacted]`, `error` ⇒ the error's code. Every other URL keeps
 * the exact original fields.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { HubLog, PreviewRoutes } from "../../../src/web-hub/hub/ports.js";
import { rawRequest } from "./helpers.js";
import { cleanupLans, startLanPv } from "./pv-lan-kit.js";
import { AGENT, SESSION, startPvHarness, type PvHarness } from "./pv-kit.js";

const CAP = "Q".repeat(43);
const SECRET_FILE = "super-secret-report.html";
const boom = (): never => {
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '/home/u/${SECRET_FILE}'`), {
    code: "ENOENT",
  });
};

const throwing = (r: PreviewRoutes): PreviewRoutes => ({
  ...r,
  servePv: async () => boom(),
  serveWrapper: async () => boom(),
  handle: async () => boom(),
});

function failedLines(lines: Array<{ level: string; msg: string; data?: object }>): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.level === "error" && /request failed/.test(l.msg))
    .map((l) => l.data as Record<string, unknown>);
}

let h: PvHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await cleanupLans();
});

describe("T-H15 log redaction", () => {
  it("loopback onRequest fallback: /pv and /pvw are redacted; query string and file name never logged", async () => {
    h = await startPvHarness({ wrapRoutes: throwing });
    const a = await rawRequest(h.port, { path: `/pv/${CAP}/${SECRET_FILE}?token=hunter2` });
    const b = await rawRequest(h.port, { path: `/pvw/${CAP}` });
    expect(a.status).toBe(500);
    expect(b.status).toBe(500);
    const lines = failedLines(h.logLines);
    expect(lines).toEqual([
      { url: "/pv/[redacted]", error: "ENOENT" },
      { url: "/pvw/[redacted]", error: "ENOENT" },
    ]);
    const all = JSON.stringify(h.logLines);
    for (const needle of [CAP, SECRET_FILE, "hunter2", "/home/u"]) expect(all).not.toContain(needle);
  });

  it("non-/pv URLs keep the exact original fields (url verbatim, String(err))", async () => {
    h = await startPvHarness({ wrapRoutes: throwing });
    const path = `/api/preview?agentKey=${AGENT}&sessionId=${SESSION}&path=%2Ftmp%2Fx.txt`;
    await rawRequest(h.port, { path, headers: { Cookie: h.cookie, "X-PWH": "1" } });
    const lines = failedLines(h.logLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      url: path,
      error: String(new Error(`ENOENT: no such file or directory, open '/home/u/${SECRET_FILE}'`)),
    });
  });

  it("LAN request fallback AND the LAN listener's outer catch are both redacted", async () => {
    // the log sink throws on its FIRST error call (recorded, then throws) ⇒ handleLanRequest's own
    // catch handler rejects ⇒ the listener-level `.catch` (the third site) logs too.
    let n = 0;
    const l = await startLanPv({
      wrapRoutes: throwing,
      wrapLog: (c): HubLog => ({
        info: c.info,
        warn: c.warn,
        error: (m, d) => {
          c.error(m, d);
          n += 1;
          if (n === 1) throw new Error("log sink down");
        },
      }),
    });
    await l.lanGet(`/pv/${CAP}/${SECRET_FILE}?token=hunter2`).catch(() => undefined);
    await l.lanGet(`/pvw/${CAP}`).catch(() => undefined);
    const lines = failedLines(l.logLines);
    // first request: site ① (LAN request catch) + site ② (listener catch); second: site ① only
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(String(line["url"])).toMatch(/^\/pvw?\/\[redacted\]$/);
      expect(["ENOENT", "Error"]).toContain(line["error"]);
    }
    expect(lines.slice(0, 2).map((x) => x["error"])).toEqual(["ENOENT", expect.any(String)]);
    const all = JSON.stringify(l.logLines);
    for (const needle of [CAP, SECRET_FILE, "hunter2", "/home/u"]) expect(all).not.toContain(needle);
  });
});
