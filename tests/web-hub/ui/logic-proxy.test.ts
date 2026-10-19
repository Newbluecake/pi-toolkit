// @vitest-environment node
/**
 * web-hub-proxy plan v2 §8 (X2): T-U1 (URL recognition corpus), T-U5 (transport contract +
 * `API.*`), the scope truth table, the contract gates, and the copy of every deny reason.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  findProxyUrlRefs,
  isProxyableHref,
  isSafeEnterUrl,
  normalizeProxyHref,
  parseIPv6,
  parseProxyList,
  parseProxyOpen,
  parseProxyStop,
  proxyErrorKey,
  proxyFetch,
  proxyFrameScopeOf,
  proxyScopeOf,
} from "../../../src/web-hub/ui/src/logic/proxy.js";
import { API, PROXY_CAPS, PROXY_DENY_REASON_SET } from "../../../src/web-hub/ui/src/logic/contract.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import { createClient } from "../../../src/web-hub/ui/src/logic/token-client.js";
import { createPasswordClient } from "../../../src/web-hub/ui/src/logic/password-client.js";
import {
  PROXY_LIST_PATH,
  PROXY_OPEN_PATH,
  PROXY_STOP_PATH,
  PROXY_LIMIT_REASONS,
  PROXY_UNAVAILABLE_EXTRA_REASONS,
} from "../../../src/web-hub/protocol/proxy.js";

import { PROXY_FRAME_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { parseProxyTarget } from "../../../src/web-hub/hub/proxy/target.js";

const refsOf = (t: string) =>
  findProxyUrlRefs(t)
    .filter((s) => s.kind === "ref")
    .map((s) => s.text);

describe("T-U1 findProxyUrlRefs / isProxyableHref corpus", () => {
  it.each([
    ["http://127.0.0.1:23434", ["http://127.0.0.1:23434"]],
    ["see http://127.0.0.1:3000/a/b?x=1#h now", ["http://127.0.0.1:3000/a/b?x=1#h"]],
    ["http://localhost:8080/", ["http://localhost:8080/"]],
    ["HTTP://LOCALHOST:8080/x", ["HTTP://LOCALHOST:8080/x"]],
    ["http://10.1.2.3:80", ["http://10.1.2.3:80"]],
    ["http://172.16.0.1:1 and http://172.31.255.255:2", ["http://172.16.0.1:1", "http://172.31.255.255:2"]],
    ["http://192.168.1.5:9000/p", ["http://192.168.1.5:9000/p"]],
    ["http://100.64.0.1:5000", ["http://100.64.0.1:5000"]],
    ["http://[::1]:3000/", ["http://[::1]:3000/"]],
    ["http://[fd12:3456::1]:3000/x", ["http://[fd12:3456::1]:3000/x"]],
    ["(http://127.0.0.1:3000/a).", ["http://127.0.0.1:3000/a"]],
    ["go to http://127.0.0.1:3000/a, then", ["http://127.0.0.1:3000/a"]],
    ['"http://127.0.0.1:3000/a"', ["http://127.0.0.1:3000/a"]],
    ["http://127.0.0.1:3000.", ["http://127.0.0.1:3000"]],
  ])("recognizes %j", (text, want) => {
    expect(refsOf(text)).toEqual(want);
  });

  it.each([
    "http://8.8.8.8:80/",
    "http://example.com:80/",
    "https://127.0.0.1:3000/",
    "http://127.0.0.1:0/",
    "http://127.0.0.1:70000/",
    "http://127.0.0.1:03000/", // leading zero
    "http://0x7f.1:80/",
    "http://127.1:80/",
    "http://2130706433:80/",
    "http://256.0.0.1:80/",
    "http://172.15.0.1:80/",
    "http://172.32.0.1:80/",
    "http://192.169.0.1:80/",
    "http://169.254.169.254:80/",
    "http://100.100.100.200:80/", // alibaba metadata
    "http://100.128.0.1:80/",
    "http://[fd00:ec2::254]:80/",
    "http://[2001:db8::1]:80/",
    "http://user@127.0.0.1:3000/",
    "xhttp://127.0.0.1:3000/",
    "//http://127.0.0.1:3000/",
    "foo/http://127.0.0.1:3000/",
    "0.0.0.0:3000",
  ])("does not recognize %j", (text) => {
    expect(refsOf(text)).toEqual([]);
  });

  it("segments always concatenate back to the input", () => {
    for (const t of [
      "a http://127.0.0.1:1/x b http://8.8.8.8:2/ c http://localhost:3.",
      "",
      "plain",
      "http://127.0.0.1:1http://127.0.0.1:2",
      "(http://10.0.0.1:1/a)(http://10.0.0.2:2/b)",
    ]) {
      expect(
        findProxyUrlRefs(t)
          .map((s) => s.text)
          .join(""),
      ).toBe(t);
    }
  });

  it("isProxyableHref needs the WHOLE href to be one URL", () => {
    expect(isProxyableHref("http://127.0.0.1:3000/a?b=1")).toBe(true);
    expect(isProxyableHref("http://localhost:1")).toBe(true);
    expect(isProxyableHref("http://127.0.0.1:3000/a b")).toBe(false);
    expect(isProxyableHref("see http://127.0.0.1:3000")).toBe(false);
    expect(isProxyableHref("http://8.8.8.8:80")).toBe(false);
    expect(isProxyableHref("http://127.0.0.1:3000/x.")).toBe(false);
    expect(isProxyableHref(undefined)).toBe(false);
    expect(isProxyableHref("http://127.0.0.1:1/" + "a".repeat(3000))).toBe(false);
  });
});

interface CorpusRef {
  text: string;
  href: string;
}
const corpus = JSON.parse(readFileSync(new URL("../../fixtures/proxy-link-corpus.json", import.meta.url), "utf8")) as {
  positive: Array<{ text: string; refs: CorpusRef[] }>;
  negative: string[];
  invalidIPv6: string[];
};

function assertHubAgreement(text: string): number {
  const segments = findProxyUrlRefs(text);
  expect(segments.map((s) => s.text).join(""), text).toBe(text);
  let count = 0;
  for (const segment of segments) {
    if (segment.kind !== "ref") continue;
    expect(parseProxyTarget(segment.href), `${text} → ${segment.href}`).toMatchObject({ ok: true });
    expect(normalizeProxyHref(segment.text), segment.text).toBe(segment.href);
    expect(normalizeProxyHref(segment.href), segment.href).toBe(segment.href);
    count++;
  }
  return count;
}

describe("link-preview LP2 — grammar corpus (§5, r1 #3/#4)", () => {
  it.each(corpus.positive)("recognizes and normalizes $text", ({ text, refs }) => {
    const actual = findProxyUrlRefs(text).filter((s) => s.kind === "ref");
    expect(actual).toEqual(refs.map((ref) => ({ kind: "ref", ...ref })));
    expect(normalizeProxyHref(text)).toBe(refs.length === 1 && refs[0]!.text === text ? refs[0]!.href : null);
    assertHubAgreement(text);
  });

  it.each(corpus.negative)("does not recognize %j (no inner re-match)", (text) => {
    expect(refsOf(text)).toEqual([]);
    expect(normalizeProxyHref(text)).toBeNull();
    assertHubAgreement(text);
  });

  it("preserves the two explicit compatibility flips with normalized hrefs", () => {
    expect(normalizeProxyHref("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeProxyHref("http://127.0.0.1/")).toBe("http://127.0.0.1:80/");
    expect(findProxyUrlRefs("127.0.0.1:3000")).toEqual([
      { kind: "ref", text: "127.0.0.1:3000", href: "http://127.0.0.1:3000" },
    ]);
  });

  it("whole-string normalization and isProxyableHref agree (including bad types and length cap)", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      1,
      {},
      [],
      "",
      " ",
      ...corpus.negative,
      ...corpus.positive.map((row) => row.text),
      "http://localhost:1/" + "a".repeat(2048),
    ];
    for (const input of inputs) expect(isProxyableHref(input), String(input)).toBe(normalizeProxyHref(input) !== null);
    const max = "http://localhost:1/".padEnd(2048, "a");
    expect(normalizeProxyHref(max)).toBe(max);
    expect(normalizeProxyHref(max + "a")).toBeNull();
  });

  it("all forbidden left-boundary characters block recognition; whitespace/punctuation allow it", () => {
    for (const prev of "aZ09_/.:@\\\\-") {
      for (const endpoint of ["127.0.0.1:3000", "http://127.0.0.1", "[fd12::1]:3000", "localhost:3000"]) {
        expect(refsOf(prev + endpoint), prev + endpoint).toEqual([]);
      }
    }
    for (const prev of [" ", "\n", "\t", "(", "=", "中"]) {
      expect(refsOf(prev + "127.0.0.1:3000")).toEqual(["127.0.0.1:3000"]);
    }
  });

  it("a rejected candidate consumes its match; a separate later candidate still works", () => {
    const text = "http://127.0.0.1:0/path/10.0.0.1:3000 then localhost:5173";
    expect(refsOf(text)).toEqual(["localhost:5173"]);
    assertHubAgreement(text);
  });

  it("tails stop at every specified delimiter without losing raw text", () => {
    for (const delimiter of [" ", "\n", "<", ">", '"', "'", "`"]) {
      const text = `localhost:3000/a${delimiter}next`;
      expect(refsOf(text)).toEqual(["localhost:3000/a"]);
      assertHubAgreement(text);
    }
  });

  it("2,000 seeded ASCII/CJK/digit/colon/bracket strings preserve concat and real hub agreement", () => {
    let seed = 0x1a2b3c4d;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:[] .,/?!@_-\\\\<>\"'`访问链接。！";
    const endpoints = [...corpus.positive.flatMap((row) => row.refs.map((ref) => ref.text)), ...corpus.negative];
    let refs = 0;
    for (let i = 0; i < 2000; i++) {
      const noise = () => Array.from({ length: next(80) }, () => alphabet[next(alphabet.length)]!).join("");
      // Half pure noise; half grammar-biased noise so agreement is not vacuously true.
      const text = i % 2 === 0 ? noise() : `${noise()} ${endpoints[next(endpoints.length)]!} ${noise()}`;
      refs += assertHubAgreement(text);
    }
    expect(refs).toBeGreaterThan(100);
  });
});

describe("parseIPv6 — RFC 4291 bytes, independent of the UI address-class fence", () => {
  it.each([
    ["::", "00000000000000000000000000000000"],
    ["::1", "00000000000000000000000000000001"],
    ["0:0:0:0:0:0:0:1", "00000000000000000000000000000001"],
    ["FD12:3456::1", "fd123456000000000000000000000001"],
    ["fd12:1:2:3:4:5:6:7", "fd120001000200030004000500060007"],
    ["1:2:3:4:5:6:7::", "00010002000300040005000600070000"],
    ["fd00::1.2.3.4", "fd000000000000000000000001020304"],
    ["1:2:3:4:5:6:1.2.3.4", "00010002000300040005000601020304"],
    ["::ffff:127.0.0.1", "00000000000000000000ffff7f000001"],
    ["2001:db8::1", "20010db8000000000000000000000001"],
  ])("%s → %s", (text, hex) => {
    const bytes = parseIPv6(text);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes!).toString("hex")).toBe(hex);
    expect(isIP(text)).toBe(6);
  });

  it.each(["", ":", ":1", "1:", "1.2.3.4", "[::1]", "::1\n", " ::1", ...corpus.invalidIPv6])(
    "rejects invalid textual syntax %j",
    (text) => {
      expect(parseIPv6(text)).toBeNull();
      // node:net accepts scoped addresses; this protocol explicitly forbids zones.
      if (!text.includes("%")) expect(isIP(text)).not.toBe(6);
    },
  );

  it.each(corpus.invalidIPv6)("invalid %s is rejected by UI AND real hub", (text) => {
    for (const ref of [`[${text}]:80`, `http://[${text}]:80`]) {
      expect(normalizeProxyHref(ref)).toBeNull();
      expect(findProxyUrlRefs(ref).filter((s) => s.kind === "ref")).toEqual([]);
      expect(parseProxyTarget(ref).ok).toBe(false);
    }
  });
});

describe("proxyFrameScopeOf — three compatibility tiers (§4.1)", () => {
  it("frame cap alone never resurrects an absent proxy scope", () => {
    expect(proxyFrameScopeOf([PROXY_FRAME_HUB_CAP], null)).toBeNull();
    expect(proxyFrameScopeOf([PROXY_FRAME_HUB_CAP], undefined)).toBeNull();
  });
  it("a proxy scope without the frame cap keeps the legacy new-tab tier", () => {
    expect(proxyFrameScopeOf(["proxy.v1"], { lan: false })).toBeNull();
    expect(proxyFrameScopeOf(undefined, { lan: false })).toBeNull();
    expect(proxyFrameScopeOf(PROXY_FRAME_HUB_CAP, { lan: false })).toBeNull();
  });
  it.each([false, true])("frame cap + existing scope (LAN %s) enables framing, preserving scope identity", (lan) => {
    const scope = { lan };
    expect(proxyFrameScopeOf([PROXY_FRAME_HUB_CAP], scope)).toBe(scope);
    expect(scope).toEqual({ lan });
  });
});

describe("proxyScopeOf truth table", () => {
  const T = { proxy: {} };
  it("null without transport / proxy method / cap", () => {
    expect(proxyScopeOf(["proxy.v1"], null)).toBeNull();
    expect(proxyScopeOf(["proxy.v1"], {})).toBeNull();
    expect(proxyScopeOf([], T)).toBeNull();
    expect(proxyScopeOf(undefined, T)).toBeNull();
    expect(proxyScopeOf(["preview.v1"], T, "token")).toBeNull();
  });
  it("token auth keys on proxy.v1, password on proxy.lan.v1", () => {
    expect(proxyScopeOf([PROXY_CAPS.token], T, "token")).toEqual({ lan: false });
    expect(proxyScopeOf([PROXY_CAPS.token], T, "password")).toBeNull();
    expect(proxyScopeOf([PROXY_CAPS.password], T, "password")).toEqual({ lan: true });
    expect(proxyScopeOf([PROXY_CAPS.password], T, "token")).toBeNull();
    expect(proxyScopeOf([PROXY_CAPS.token, PROXY_CAPS.password], T, "password")).toEqual({ lan: true });
  });
  it("without a mode, proxy.v1 wins, else the lan cap", () => {
    expect(proxyScopeOf([PROXY_CAPS.token, PROXY_CAPS.password], T)).toEqual({ lan: false });
    expect(proxyScopeOf([PROXY_CAPS.password], T)).toEqual({ lan: true });
  });
});

describe("contract gates", () => {
  const open = {
    instanceId: "inst_12345678",
    origin: "http://127.0.0.1:7900",
    enterUrl: "http://127.0.0.1:7900/__pwh_proxy__/enter?c=" + "A".repeat(43),
    target: { host: "127.0.0.1", port: 23434, cls: "loopback" },
  };
  it("parseProxyOpen accepts the contract shape and rejects drift", () => {
    expect(parseProxyOpen(open)).toEqual(open);
    expect(parseProxyOpen({ ...open, enterUrl: "http://evil.test/x" })).toBeNull();
    expect(parseProxyOpen({ ...open, enterUrl: "javascript:alert(1)" })).toBeNull();
    expect(parseProxyOpen({ ...open, origin: "https://127.0.0.1:7900" })).toBeNull();
    expect(parseProxyOpen({ ...open, target: { ...open.target, cls: "public" } })).toBeNull();
    expect(parseProxyOpen({ ...open, target: { ...open.target, port: 0 } })).toBeNull();
    expect(parseProxyOpen({ ...open, instanceId: "x" })).toBeNull();
    expect(parseProxyOpen(null)).toBeNull();
  });
  it("parseProxyList / parseProxyStop", () => {
    const list = {
      items: [{ instanceId: open.instanceId, target: open.target, origin: open.origin, createdAt: 1, mine: true }],
      policy: { maxProxies: 8, portRange: [7900, 7949], lan: false },
    };
    expect(parseProxyList(list)).toEqual(list);
    expect(parseProxyList({ ...list, items: [{}] })).toBeNull();
    expect(parseProxyList({ ...list, policy: { maxProxies: 8 } })).toBeNull();
    expect(parseProxyStop({ ok: true })).toEqual({ ok: true });
    expect(parseProxyStop({ ok: false })).toBeNull();
  });
  it("isSafeEnterUrl pins scheme + reserved path", () => {
    expect(isSafeEnterUrl(open.enterUrl)).toBe(true);
    expect(isSafeEnterUrl("http://127.0.0.1:7900/other?c=abc")).toBe(false);
    expect(isSafeEnterUrl("https://127.0.0.1:7900/__pwh_proxy__/enter?c=abc")).toBe(false);
    expect(isSafeEnterUrl("http://127.0.0.1:7900/__pwh_proxy__/enter?c=a b")).toBe(false);
  });
});

describe("user-facing copy of every outcome", () => {
  const zh = MESSAGES.zh["proxy"]!;
  const en = MESSAGES.en["proxy"]!;
  const keyOf = (k: string) => k.replace(/^proxy\./, "");
  it("every deny reason / extra reason / limit has a zh+en sentence", () => {
    for (const reason of PROXY_DENY_REASON_SET) {
      for (const error of ["E_PROXY_DENIED", "E_PROXY_UNAVAILABLE"]) {
        const k = keyOf(proxyErrorKey({ status: 403, error, reason }));
        expect(k).toBe(`reason.${reason}`);
        expect(zh[k], k).toBeTruthy();
        expect(en[k], k).toBeTruthy();
      }
    }
    for (const reason of PROXY_UNAVAILABLE_EXTRA_REASONS) {
      const k = keyOf(proxyErrorKey({ status: 503, error: "E_PROXY_UNAVAILABLE", reason }));
      expect(zh[k] && en[k], k).toBeTruthy();
    }
    for (const reason of PROXY_LIMIT_REASONS) {
      const k = keyOf(proxyErrorKey({ status: 409, error: "E_LIMIT", reason }));
      expect(zh[k] && en[k], k).toBeTruthy();
    }
  });
  it("unknown reasons / codes fall back to generic copy that exists", () => {
    const cases = [
      { error: "E_PROXY_DENIED", reason: "from-the-future" },
      { error: "E_PROXY_UNAVAILABLE" },
      { error: "E_LIMIT", reason: "?" },
      { error: "E_RATE" },
      { error: "E_AUTH" },
      { error: "E_AUTH", reason: "cookie-conflict" },
      { error: "E_NOT_FOUND", status: 404 },
      { error: "E_NETWORK" },
      { error: "E_DEADLINE" },
      { error: "E_ABORT" },
      { error: "E_BAD_RESPONSE" },
      { error: "HTTP 500" },
    ];
    for (const c of cases) {
      const k = keyOf(proxyErrorKey(c));
      expect(zh[k] && en[k], JSON.stringify(c)).toBeTruthy();
    }
    expect(proxyErrorKey({ error: "E_AUTH", reason: "cookie-conflict" })).toBe("proxy.cookieConflict");
  });
  it("cookie-conflict copy tells the user to clear cookies manually (best-effort, §R2 #4)", () => {
    expect(zh["cookieConflict"]).toMatch(/清除/);
  });
});

// Run the SAME wire/error assertions against both independent implementations. In particular,
// password-client's private proxyPost must not drift from the token client's POST contract.
describe.each([
  ["token", createClient],
  ["password", createPasswordClient],
] as const)("T-U5 API.* + %s client proxy namespace", (_mode, create) => {
  it("API paths are the protocol constants", () => {
    expect(API.proxyOpen).toBe(PROXY_OPEN_PATH);
    expect(API.proxyList).toBe(PROXY_LIST_PATH);
    expect(API.proxyStop).toBe(PROXY_STOP_PATH);
  });

  function res(status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k] ?? null },
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  }
  function make(fetch: ReturnType<typeof vi.fn>) {
    return create({
      fetch,
      EventSource: class {} as never,
      storage: { getItem: () => null, setItem() {}, removeItem() {} },
      location: { hash: "", pathname: "/", search: "" } as never,
      history: { replaceState() {} } as never,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: never) => clearTimeout(h),
      now: () => Date.now(),
      onMessage() {},
      onConn() {},
    } as never);
  }
  const openBody = {
    instanceId: "inst_12345678",
    origin: "http://127.0.0.1:7900",
    enterUrl: "http://127.0.0.1:7900/__pwh_proxy__/enter?c=" + "B".repeat(43),
    target: { host: "localhost", port: 3000, cls: "loopback" },
  };

  it("open: POST + X-PWH + JSON body, success carries the protocol body", async () => {
    const fetch = vi.fn(async () => res(200, openBody));
    const out = await make(fetch).proxy.open({ target: "localhost:3000" });
    expect(out).toEqual({ ...openBody, ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/proxy/open");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "X-PWH": "1", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ target: "localhost:3000" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("open: error bodies ride verbatim (error/reason/retryAfterS/status)", async () => {
    const fetch = vi.fn(async () => res(403, { error: "E_PROXY_DENIED", reason: "public" }, { "Retry-After": "3" }));
    const out = await make(fetch).proxy.open({ target: "8.8.8.8:80" });
    expect(out).toEqual({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public", retryAfterS: 3 });
  });

  it("open: off-contract 200 ⇒ E_BAD_RESPONSE; network failure ⇒ E_NETWORK; abort ⇒ E_ABORT", async () => {
    expect(await make(vi.fn(async () => res(200, { nope: 1 }))).proxy.open({ target: "x" })).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
    expect(
      await make(
        vi.fn(async () => {
          throw new TypeError("boom");
        }),
      ).proxy.open({ target: "x" }),
    ).toEqual({ ok: false, status: 0, error: "E_NETWORK" });
    const ac = new AbortController();
    ac.abort();
    expect(await make(vi.fn()).proxy.open({ target: "x" }, { signal: ac.signal })).toEqual({
      ok: false,
      status: 0,
      error: "E_ABORT",
    });
  });

  it("list: GET /api/proxy with X-PWH; stop: POST {instanceId}", async () => {
    const list = { items: [], policy: { maxProxies: 8, portRange: [7900, 7949], lan: false } };
    const fetch = vi.fn(async (url: string) => (url === "/api/proxy" ? res(200, list) : res(200, { ok: true })));
    const c = make(fetch as never);
    expect(await c.proxy.list()).toEqual({ ...list, ok: true });
    const [lu, li] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect([lu, li.method, (li.headers as Record<string, string>)["X-PWH"]]).toEqual(["/api/proxy", "GET", "1"]);
    expect(li.credentials).toBe("same-origin");
    expect(li.body).toBeUndefined();
    expect(await c.proxy.stop("inst_12345678")).toEqual({ ok: true });
    const [su, si] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(su).toBe("/api/proxy/stop");
    expect(si.method).toBe("POST");
    expect(si.credentials).toBe("same-origin");
    expect(si.headers).toMatchObject({ "X-PWH": "1", "Content-Type": "application/json" });
    expect(JSON.parse(si.body as string)).toEqual({ instanceId: "inst_12345678" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // open/list/stop each traverse their real client entrypoint, not just proxyFetch in isolation.
  const operations = ["open", "list", "stop"] as const;
  function call(c: ReturnType<typeof make>, op: (typeof operations)[number], opts?: { signal: AbortSignal }) {
    if (op === "open") return c.proxy.open({ target: "localhost:3000" }, opts);
    if (op === "stop") return c.proxy.stop("inst_12345678", opts);
    return c.proxy.list(opts);
  }

  it.each(operations)(
    "%s: denial, unavailable, conflict and fallback errors keep their status/reason/retry",
    async (op) => {
      for (const [status, body, headers, expected] of [
        [403, { error: "E_PROXY_DENIED", reason: "public" }, {}, { error: "E_PROXY_DENIED", reason: "public" }],
        [
          503,
          { error: "E_PROXY_UNAVAILABLE", reason: "closing" },
          { "Retry-After": "2" },
          { error: "E_PROXY_UNAVAILABLE", reason: "closing", retryAfterS: 2 },
        ],
        [401, { error: "E_AUTH", reason: "cookie-conflict" }, {}, { error: "E_AUTH", reason: "cookie-conflict" }],
        [429, { error: "E_RATE" }, { "Retry-After": "3" }, { error: "E_RATE", retryAfterS: 3 }],
        [401, {}, {}, { error: "E_AUTH" }],
        [500, {}, { "Retry-After": "not-a-number" }, { error: "HTTP 500" }],
      ] as const) {
        const fetch = vi.fn(async () => res(status, body, headers));
        expect(await call(make(fetch), op)).toEqual({ ok: false, status, ...expected });
        expect(fetch).toHaveBeenCalledTimes(1); // never silently retry a failed mint/stop or LAN login
      }
    },
  );

  it.each(operations)(
    "%s: malformed success/network/pre-abort map to local errors; pre-abort never sends",
    async (op) => {
      expect(await call(make(vi.fn(async () => res(200, { nope: 1 }))), op)).toEqual({
        ok: false,
        status: 0,
        error: "E_BAD_RESPONSE",
      });
      expect(
        await call(
          make(
            vi.fn(async () => {
              throw new TypeError("offline");
            }),
          ),
          op,
        ),
      ).toEqual({
        ok: false,
        status: 0,
        error: "E_NETWORK",
      });
      const fetch = vi.fn();
      const ac = new AbortController();
      ac.abort();
      expect(await call(make(fetch), op, { signal: ac.signal })).toEqual({ ok: false, status: 0, error: "E_ABORT" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("proxyFetch caps the body", async () => {
    const big = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(100) };
    expect(
      await proxyFetch(
        async () => big,
        () => ({}),
        10,
      ),
    ).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
  });
});
