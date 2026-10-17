/**
 * web-hub-proxy plan v2 §12 package X0 (frozen surface): pins EVERY constant, literal set, cap name,
 * wire-shape helper, the `webHub.proxy.*` settings (defaults / parse / specs) and the UI-side
 * contract mirrors that X1a/X1b/X1c/X2 build against. X0 adds declarations only — nothing here
 * exercises runtime wiring (no listener, no route); a number changing here is a plan change.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  DEFAULT_WEBHUB_PROXY_SETTINGS,
  loadSettings,
  parseWebHubProxyBlock,
  parseWebHubSettings,
} from "../../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
} from "../../../src/config/setting-specs.js";
import type { HubConfig, ProxyRoutes, ProxyService } from "../../../src/web-hub/hub/ports.js";
import { COOKIE_CONFLICT_REASON } from "../../../src/web-hub/hub/auth-identity.js";
import {
  PROXY_ACTIVE_GLOBAL,
  PROXY_ACTIVE_PER_INSTANCE,
  PROXY_AGENT_OPTIONS,
  PROXY_BIND_HOST_LAN,
  PROXY_BIND_HOST_LOOPBACK,
  PROXY_CAP_REASONS,
  PROXY_CLOSE_DEADLINE_MS,
  PROXY_CODE_TTL_MS,
  PROXY_CODES_GLOBAL,
  PROXY_CODES_PER_INSTANCE,
  PROXY_CONN_GUARD,
  PROXY_CONNECT_TIMEOUT_MS,
  PROXY_COOKIE_CONFLICT_REASON,
  PROXY_COOKIE_PREFIX,
  PROXY_DEFAULT_MAX_PROXIES,
  PROXY_DEFAULT_PORT_RANGE,
  PROXY_DEFAULT_PORT_RANGE_TEXT,
  PROXY_DENY_LOG_THROTTLE_MS,
  PROXY_DENY_REASONS,
  PROXY_DNS_TIMEOUT_MS,
  PROXY_DROPPED_REQUEST_HEADER_PREFIXES,
  PROXY_DROPPED_REQUEST_HEADERS,
  PROXY_DROPPED_RESPONSE_HEADERS,
  PROXY_END_LOG_FIELDS,
  PROXY_ENTER_BAD_CODE_WEIGHT,
  PROXY_ENTER_PATH,
  PROXY_ENTER_QUERY,
  PROXY_ENTER_RATE_PER_MIN,
  PROXY_ERROR_CODES,
  PROXY_EXPIRED_PAGE_EN,
  PROXY_EXPIRED_PAGE_ZH,
  PROXY_HEAD_TIMEOUT_MS,
  PROXY_INSTANCE_ID_RE,
  PROXY_INSTANCE_IDLE_MS,
  PROXY_LIMIT_REASONS,
  PROXY_LIST_PATH,
  PROXY_LISTEN_TIMEOUT_MS,
  PROXY_LISTENER_STATUS,
  PROXY_LOG_EVENTS,
  PROXY_MAX_HEADER_BYTES,
  PROXY_MAX_PROXIES_MAX,
  PROXY_MAX_PROXIES_MIN,
  PROXY_MAX_REQUESTS_PER_SOCKET,
  PROXY_NEXT_PATH_MAX_BYTES,
  PROXY_OPEN_BUCKET_CAPACITY,
  PROXY_OPEN_BUCKET_REFILL_MS,
  PROXY_OPEN_LOG_FIELDS,
  PROXY_OPEN_MAX_BODY_BYTES,
  PROXY_OPEN_PATH,
  PROXY_PER_PRINCIPAL_MAX,
  PROXY_PORT_BIND_ATTEMPTS,
  PROXY_PORT_RANGE_MAX_PORT,
  PROXY_PORT_RANGE_MAX_SPAN,
  PROXY_PORT_RANGE_MIN_PORT,
  PROXY_PORTS_FILE_NAME,
  PROXY_PORTS_FILE_VERSION,
  PROXY_QUEUE_GLOBAL,
  PROXY_QUEUE_PER_INSTANCE,
  PROXY_QUEUE_WAIT_MS,
  PROXY_REASON_RESPONSE,
  PROXY_REQUEST_BODY_MAX_BYTES,
  PROXY_RESERVED_PREFIX,
  PROXY_RETRY_AFTER_S,
  PROXY_SECRET_BYTES,
  PROXY_SECRET_RE,
  PROXY_SERVER_OPTIONS,
  PROXY_SESSION_HARD_MS,
  PROXY_SESSION_IDLE_MS,
  PROXY_SESSIONS_GLOBAL,
  PROXY_SESSIONS_PER_INSTANCE,
  PROXY_SOCKET_TIMEOUT_MS,
  PROXY_STATE_DIR_NAME,
  PROXY_STOP_PATH,
  PROXY_STREAM_HWM_BYTES,
  PROXY_STRIPPED_COOKIE_PREFIX,
  PROXY_SWEEP_INTERVAL_MS,
  PROXY_TARGET_CLASSES,
  PROXY_TOMBSTONE_RING,
  PROXY_TOUCH_THROTTLE_MS,
  PROXY_UNAVAILABLE_EXTRA_REASONS,
  PROXY_UPSTREAM_IDLE_MS,
  PROXY_WS_GLOBAL,
  PROXY_WS_HANDSHAKE_MS,
  PROXY_WS_IDLE_MS,
  PROXY_WS_NON101_BODY_MAX_BYTES,
  PROXY_WS_PER_INSTANCE,
  buildProxyEnterUrl,
  formatProxyPortRange,
  parseProxyPortRange,
  proxyCookieName,
  proxyOriginOf,
  proxyRangeContainsPort,
  type ProxyDenyReason,
} from "../../../src/web-hub/protocol/proxy.js";
import { PROXY_HUB_CAP, PROXY_LAN_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import * as web from "../../../src/web-hub/ui/src/logic/contract.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("protocol/proxy — paths, prefix, cookie (plan §3.5/§3.8)", () => {
  it("pins the three hub API paths and the reserved listener prefix", () => {
    expect(PROXY_OPEN_PATH).toBe("/api/proxy/open");
    expect(PROXY_LIST_PATH).toBe("/api/proxy");
    expect(PROXY_STOP_PATH).toBe("/api/proxy/stop");
    expect(PROXY_RESERVED_PREFIX).toBe("/__pwh_proxy__/");
    expect(PROXY_ENTER_PATH).toBe("/__pwh_proxy__/enter");
    expect(PROXY_ENTER_PATH.startsWith(PROXY_RESERVED_PREFIX)).toBe(true);
    expect(PROXY_ENTER_QUERY).toBe("c");
  });

  it("gate cookie is pwh_px_<port>, disjoint from the hub cookies and inside the stripped pwh_ family", () => {
    expect(PROXY_COOKIE_PREFIX).toBe("pwh_px_");
    expect(proxyCookieName(7901)).toBe("pwh_px_7901");
    expect(proxyCookieName(7901).startsWith(PROXY_STRIPPED_COOKIE_PREFIX)).toBe(true);
    expect(PROXY_STRIPPED_COOKIE_PREFIX).toBe("pwh_");
    for (const hubCookie of ["pwh_sid", "pwh_lan"]) expect(hubCookie.startsWith(PROXY_COOKIE_PREFIX)).toBe(false);
  });

  it("builds origin / enterUrl exactly as plan §2/§3.4 show", () => {
    const origin = proxyOriginOf("127.0.0.1", 7901);
    expect(origin).toBe("http://127.0.0.1:7901");
    const code = "A".repeat(43);
    expect(buildProxyEnterUrl(origin, code)).toBe(`http://127.0.0.1:7901/__pwh_proxy__/enter?c=${code}`);
  });

  it("pins the dropped-header families (plan §3.6)", () => {
    expect([...PROXY_DROPPED_RESPONSE_HEADERS]).toEqual(["clear-site-data"]);
    expect([...PROXY_DROPPED_REQUEST_HEADERS]).toEqual(["x-pwh", "forwarded", "x-real-ip"]);
    expect([...PROXY_DROPPED_REQUEST_HEADER_PREFIXES]).toEqual(["proxy-", "x-forwarded-"]);
  });

  it("bind hosts (plan §3.4: LAN on ⇒ 0.0.0.0 like LAN_BIND_HOST, else loopback)", () => {
    expect(PROXY_BIND_HOST_LAN).toBe("0.0.0.0");
    expect(PROXY_BIND_HOST_LOOPBACK).toBe("127.0.0.1");
  });
});

describe("protocol/proxy — port range + instance limits (plan §0 Q3, §3.3–§3.4, §5)", () => {
  it("pins Q3 and the §5 setting domain", () => {
    expect([...PROXY_DEFAULT_PORT_RANGE]).toEqual([7900, 7949]);
    expect(PROXY_DEFAULT_PORT_RANGE_TEXT).toBe("7900-7949");
    expect(Object.isFrozen(PROXY_DEFAULT_PORT_RANGE)).toBe(true);
    expect(PROXY_DEFAULT_MAX_PROXIES).toBe(8);
    expect([PROXY_MAX_PROXIES_MIN, PROXY_MAX_PROXIES_MAX]).toEqual([1, 16]);
    expect(PROXY_PORT_RANGE_MAX_SPAN).toBe(256);
    expect([PROXY_PORT_RANGE_MIN_PORT, PROXY_PORT_RANGE_MAX_PORT]).toEqual([1024, 65_535]);
    expect(PROXY_PER_PRINCIPAL_MAX).toBe(4);
    expect(PROXY_PORT_BIND_ATTEMPTS).toBe(8);
  });

  it("pins the ports.json location (the IO budgets are deliberately NOT frozen here)", () => {
    expect(PROXY_PORTS_FILE_VERSION).toBe(1);
    expect(PROXY_STATE_DIR_NAME).toBe("proxy");
    expect(PROXY_PORTS_FILE_NAME).toBe("ports.json");
  });

  it("pins the listen / DNS / close deadlines", () => {
    expect(PROXY_LISTEN_TIMEOUT_MS).toBe(2_000);
    expect(PROXY_DNS_TIMEOUT_MS).toBe(2_000);
    expect(PROXY_CLOSE_DEADLINE_MS).toBe(2_000);
  });

  it("default range / maxProxies are self-consistent with the limits", () => {
    const [lo, hi] = PROXY_DEFAULT_PORT_RANGE;
    expect(hi - lo + 1).toBe(50);
    expect(hi - lo + 1).toBeLessThanOrEqual(PROXY_PORT_RANGE_MAX_SPAN);
    expect(lo).toBeGreaterThanOrEqual(PROXY_PORT_RANGE_MIN_PORT);
    expect(PROXY_DEFAULT_MAX_PROXIES).toBeLessThanOrEqual(hi - lo + 1);
    expect(PROXY_DEFAULT_MAX_PROXIES).toBeGreaterThanOrEqual(PROXY_MAX_PROXIES_MIN);
    expect(PROXY_DEFAULT_MAX_PROXIES).toBeLessThanOrEqual(PROXY_MAX_PROXIES_MAX);
    expect(PROXY_PER_PRINCIPAL_MAX).toBeLessThanOrEqual(PROXY_DEFAULT_MAX_PROXIES);
    expect(PROXY_PORT_BIND_ATTEMPTS).toBeLessThanOrEqual(hi - lo + 1);
  });
});

describe("protocol/proxy — secrets, codes, sessions, revocation (plan §0 Q4, §3.2, §3.4)", () => {
  it("pins the secret shape and the instance-id grammar", () => {
    expect(PROXY_SECRET_BYTES).toBe(32);
    expect(PROXY_SECRET_RE.test("A".repeat(43))).toBe(true);
    expect(PROXY_SECRET_RE.test("A".repeat(42))).toBe(false);
    expect(PROXY_SECRET_RE.test("A".repeat(44))).toBe(false);
    expect(PROXY_SECRET_RE.test(`${"A".repeat(42)}=`)).toBe(false);
    expect(PROXY_SECRET_RE.test(`${"A".repeat(42)}\n`)).toBe(false);
    expect(PROXY_INSTANCE_ID_RE.test("px_abc12345")).toBe(true);
    expect(PROXY_INSTANCE_ID_RE.test("short")).toBe(false);
    expect(PROXY_INSTANCE_ID_RE.test("has space1")).toBe(false);
    expect(PROXY_INSTANCE_ID_RE.test("a".repeat(65))).toBe(false);
  });

  it("pins the TTLs (Q4: idle 2 h, absolute 12 h; code 60 s)", () => {
    expect(PROXY_CODE_TTL_MS).toBe(60_000);
    expect(PROXY_SESSION_IDLE_MS).toBe(2 * HOUR);
    expect(PROXY_SESSION_HARD_MS).toBe(12 * HOUR);
    expect(PROXY_TOUCH_THROTTLE_MS).toBe(60_000);
    expect(PROXY_INSTANCE_IDLE_MS).toBe(15 * MIN);
    expect(PROXY_SWEEP_INTERVAL_MS).toBe(30_000);
    // idle < hard (activity never extends the absolute limit); throttle ≪ idle; sweep ≪ instance idle
    expect(PROXY_SESSION_IDLE_MS).toBeLessThan(PROXY_SESSION_HARD_MS);
    expect(PROXY_TOUCH_THROTTLE_MS).toBeLessThan(PROXY_SESSION_IDLE_MS);
    expect(PROXY_SWEEP_INTERVAL_MS).toBeLessThan(PROXY_INSTANCE_IDLE_MS);
  });

  it("pins the code/session/tombstone caps (refuse, never evict)", () => {
    expect(PROXY_CODES_PER_INSTANCE).toBe(16);
    expect(PROXY_SESSIONS_PER_INSTANCE).toBe(16);
    expect(PROXY_CODES_GLOBAL).toBe(128);
    expect(PROXY_SESSIONS_GLOBAL).toBe(128);
    expect(PROXY_TOMBSTONE_RING).toBe(256);
    expect(PROXY_SESSIONS_PER_INSTANCE).toBeLessThanOrEqual(PROXY_SESSIONS_GLOBAL);
    expect(PROXY_CODES_PER_INSTANCE).toBeLessThanOrEqual(PROXY_CODES_GLOBAL);
  });
});

describe("protocol/proxy — listener / admission / forwarding / WebSocket caps (plan §3.5–§3.7)", () => {
  it("pins the http.Server options (connectionsCheckingInterval 1000 ⇒ half headers die ≤ 11 s)", () => {
    expect({ ...PROXY_SERVER_OPTIONS }).toEqual({
      maxHeaderSize: 16_384,
      headersTimeout: 10_000,
      requestTimeout: 300_000,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    });
    expect(Object.isFrozen(PROXY_SERVER_OPTIONS)).toBe(true);
    expect(PROXY_SERVER_OPTIONS.headersTimeout + PROXY_SERVER_OPTIONS.connectionsCheckingInterval).toBeLessThanOrEqual(
      11_000,
    );
    expect(PROXY_MAX_REQUESTS_PER_SOCKET).toBe(1_000);
    expect(PROXY_SOCKET_TIMEOUT_MS).toBe(120_000);
  });

  it("pins the conn-guard options (direct pool only)", () => {
    expect({ ...PROXY_CONN_GUARD }).toEqual({
      directTotalPerIp: 48,
      directUnauthPoolCap: 32,
      directUnauthPerIpCap: 8,
      maxConnections: 256,
    });
    expect(Object.isFrozen(PROXY_CONN_GUARD)).toBe(true);
  });

  it("pins the enter bucket and the nextPath cap", () => {
    expect(PROXY_ENTER_RATE_PER_MIN).toBe(20);
    expect(PROXY_ENTER_BAD_CODE_WEIGHT).toBe(2);
    expect(PROXY_NEXT_PATH_MAX_BYTES).toBe(2048);
  });

  it("pins request admission, the bounded queue and the agent options", () => {
    expect(PROXY_ACTIVE_PER_INSTANCE).toBe(32);
    expect(PROXY_ACTIVE_GLOBAL).toBe(128);
    expect(PROXY_QUEUE_PER_INSTANCE).toBe(64);
    expect(PROXY_QUEUE_GLOBAL).toBe(256);
    expect(PROXY_QUEUE_WAIT_MS).toBe(10_000);
    expect(PROXY_RETRY_AFTER_S).toBe(1);
    expect({ ...PROXY_AGENT_OPTIONS }).toEqual({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4, timeout: 60_000 });
    // admission keeps active ≤ maxSockets, so the agent's unbounded queue is never used
    expect(PROXY_AGENT_OPTIONS.maxSockets).toBe(PROXY_ACTIVE_PER_INSTANCE);
    expect(PROXY_AGENT_OPTIONS.maxFreeSockets).toBeLessThanOrEqual(PROXY_AGENT_OPTIONS.maxSockets);
    expect(PROXY_ACTIVE_PER_INSTANCE).toBeLessThanOrEqual(PROXY_ACTIVE_GLOBAL);
    expect(PROXY_QUEUE_PER_INSTANCE).toBeLessThanOrEqual(PROXY_QUEUE_GLOBAL);
  });

  it("pins upstream timers, body/header caps and the stream highWaterMark", () => {
    expect(PROXY_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_HEAD_TIMEOUT_MS).toBe(120_000);
    expect(PROXY_UPSTREAM_IDLE_MS).toBe(300_000);
    expect(PROXY_REQUEST_BODY_MAX_BYTES).toBe(256 * MiB);
    expect(PROXY_MAX_HEADER_BYTES).toBe(16_384);
    expect(PROXY_STREAM_HWM_BYTES).toBe(65_536);
    expect(PROXY_CONNECT_TIMEOUT_MS).toBeLessThan(PROXY_HEAD_TIMEOUT_MS);
    expect(PROXY_HEAD_TIMEOUT_MS).toBeLessThan(PROXY_UPSTREAM_IDLE_MS);
  });

  it("pins the WebSocket caps (handshake 10 s ≪ established-idle 30 min, §R2 #11)", () => {
    expect(PROXY_WS_HANDSHAKE_MS).toBe(10_000);
    expect(PROXY_WS_IDLE_MS).toBe(30 * MIN);
    expect(PROXY_WS_PER_INSTANCE).toBe(32);
    expect(PROXY_WS_GLOBAL).toBe(64);
    expect(PROXY_WS_NON101_BODY_MAX_BYTES).toBe(64 * KiB);
    expect(PROXY_WS_HANDSHAKE_MS).toBeLessThan(PROXY_WS_IDLE_MS);
    expect(PROXY_WS_PER_INSTANCE).toBeLessThanOrEqual(PROXY_WS_GLOBAL);
    expect(PROXY_WS_GLOBAL).toBeLessThanOrEqual(PROXY_ACTIVE_GLOBAL);
  });

  it("pins the proxy-listener statuses (§3.5) and the fixed page copy", () => {
    expect({ ...PROXY_LISTENER_STATUS }).toEqual({
      hostMismatch: 421,
      methodNotAllowed: 405,
      badTarget: 400,
      enterFailed: 410,
      gateFailed: 401,
      originForbidden: 403,
      reservedNotFound: 404,
      busy: 503,
      rateLimited: 429,
      badGateway: 502,
      gatewayTimeout: 504,
      bodyTooLarge: 413,
    });
    expect(PROXY_EXPIRED_PAGE_ZH).toBe("链接已失效，请回到 hub 重新打开");
    expect(PROXY_EXPIRED_PAGE_EN).toBe("Link expired");
  });
});

describe("protocol/proxy — hub API bodies, deny reasons and error shapes (plan §3.4/§3.8)", () => {
  it("pins the open body cap and the per-principal bucket", () => {
    expect(PROXY_OPEN_MAX_BODY_BYTES).toBe(2 * KiB);
    expect(PROXY_OPEN_BUCKET_CAPACITY).toBe(10);
    expect(PROXY_OPEN_BUCKET_REFILL_MS).toBe(6_000);
  });

  it("target classes are the closed allowed-address set", () => {
    expect([...PROXY_TARGET_CLASSES]).toEqual(["loopback", "private", "cgnat", "ula"]);
  });

  it("deny reasons are EXACTLY the plan §3.8 closed set, in plan order", () => {
    expect([...PROXY_DENY_REASONS]).toEqual(
      (
        "syntax|scheme|userinfo|port|public|link-local|metadata|multicast|reserved|translation|unspecified|mixed-answer|" +
        "dns-failed|dns-timeout|self-port|port-busy|ports-exhausted|ports-store|reverse-proxy"
      ).split("|"),
    );
    expect(new Set(PROXY_DENY_REASONS).size).toBe(PROXY_DENY_REASONS.length);
    expect(PROXY_DENY_REASONS).toHaveLength(19);
  });

  it("error codes: the two new ones are declared, E_LIMIT / E_RATE are the existing codes", () => {
    expect([...PROXY_ERROR_CODES]).toEqual(["E_PROXY_DENIED", "E_PROXY_UNAVAILABLE"]);
    expect([...PROXY_LIMIT_REASONS]).toEqual(["proxies", "ports-exhausted"]);
    expect([...PROXY_UNAVAILABLE_EXTRA_REASONS]).toEqual(["closing", "revocation-gap", "listen-timeout"]);
    expect([...PROXY_CAP_REASONS]).toEqual(["codes", "sessions"]);
    for (const r of [...PROXY_UNAVAILABLE_EXTRA_REASONS, ...PROXY_CAP_REASONS]) {
      expect((PROXY_DENY_REASONS as readonly string[]).includes(r)).toBe(false);
    }
    // the only documented overlap: ports-exhausted is both a deny literal and an E_LIMIT reason
    expect(PROXY_LIMIT_REASONS.filter((r) => (PROXY_DENY_REASONS as readonly string[]).includes(r))).toEqual([
      "ports-exhausted",
    ]);
  });

  it("every deny reason has exactly one status/error pairing, matching plan §3.8's classes", () => {
    expect(Object.keys(PROXY_REASON_RESPONSE).sort()).toEqual([...PROXY_DENY_REASONS].sort());
    const allowedErrors = new Set<string>([...PROXY_ERROR_CODES, "E_LIMIT"]);
    for (const reason of PROXY_DENY_REASONS) {
      const row = PROXY_REASON_RESPONSE[reason];
      expect(allowedErrors.has(row.error), reason).toBe(true);
      expect([400, 403, 409, 503]).toContain(row.status);
      if (row.status === 400 || row.status === 403) expect(row.error).toBe("E_PROXY_DENIED");
      if (row.status === 503) expect(row.error).toBe("E_PROXY_UNAVAILABLE");
    }
    // plan-text anchors: §3.3 ports-store/port-busy 503, ports-exhausted 409 E_LIMIT, §3.4 reverse-proxy 409
    expect(PROXY_REASON_RESPONSE["ports-store"]).toEqual({ status: 503, error: "E_PROXY_UNAVAILABLE" });
    expect(PROXY_REASON_RESPONSE["port-busy"]).toEqual({ status: 503, error: "E_PROXY_UNAVAILABLE" });
    expect(PROXY_REASON_RESPONSE["ports-exhausted"]).toEqual({ status: 409, error: "E_LIMIT" });
    expect(PROXY_REASON_RESPONSE["reverse-proxy"]).toEqual({ status: 409, error: "E_PROXY_UNAVAILABLE" });
    // the grammar family is 400, the address-class family is 403
    for (const r of ["syntax", "scheme", "userinfo", "port"] as const) {
      expect(PROXY_REASON_RESPONSE[r].status).toBe(400);
    }
    for (const r of [
      "public",
      "link-local",
      "metadata",
      "multicast",
      "reserved",
      "translation",
      "unspecified",
      "mixed-answer",
      "self-port",
    ] as const) {
      expect(PROXY_REASON_RESPONSE[r].status).toBe(403);
    }
    expect(Object.isFrozen(PROXY_REASON_RESPONSE)).toBe(true);
  });

  it("the 401 conflict reason is a parity copy of the hub's COOKIE_CONFLICT_REASON", () => {
    expect(PROXY_COOKIE_CONFLICT_REASON).toBe("cookie-conflict");
    expect(PROXY_COOKIE_CONFLICT_REASON).toBe(COOKIE_CONFLICT_REASON);
  });

  it("pins the log event names and field whitelists (plan §7: never paths/queries/headers/cookies/codes/sids)", () => {
    expect([...PROXY_LOG_EVENTS]).toEqual(["proxy-open", "proxy-end"]);
    expect([...PROXY_OPEN_LOG_FIELDS]).toEqual([
      "ok",
      "reason",
      "principal",
      "listener",
      "cls",
      "target",
      "host",
      "port",
    ]);
    expect([...PROXY_END_LOG_FIELDS]).toEqual(["instTag", "end", "reqs", "bytesUp", "bytesDown", "ws"]);
    for (const banned of ["path", "url", "query", "header", "cookie", "code", "sid"]) {
      expect(PROXY_OPEN_LOG_FIELDS as readonly string[]).not.toContain(banned);
      expect(PROXY_END_LOG_FIELDS as readonly string[]).not.toContain(banned);
    }
    expect(PROXY_DENY_LOG_THROTTLE_MS).toBe(60_000);
  });

  it("protocol/proxy.ts has zero imports (browser-reachable through the @protocol alias)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../src/web-hub/protocol/proxy.ts", import.meta.url)), "utf8");
    expect(/^\s*import\s/m.test(src)).toBe(false);
    expect(/from\s+["']/.test(src)).toBe(false);
  });
});

describe("protocol/proxy — portRange grammar (plan §5)", () => {
  const good: Array<[string, [number, number]]> = [
    ["7900-7949", [7900, 7949]],
    [" 7900-7949 ", [7900, 7949]],
    ["1024-1024", [1024, 1024]],
    ["1024-1279", [1024, 1279]], // exactly 256 ports
    ["65280-65535", [65280, 65535]], // exactly 256 ports at the top of the port space
    ["7900-7949\n", [7900, 7949]], // outer whitespace (incl. newline) is trimmed
  ];
  const bad: unknown[] = [
    "",
    "7900",
    "7900-",
    "-7949",
    "7949-7900", // lo > hi
    "7900 - 7949", // inner whitespace
    "07900-7949", // leading zero
    "7900-07949",
    "7900–7949", // en dash
    "7900-7949-8000",
    "1023-1100", // privileged
    "1024-1280", // 257 ports
    "7900-65536",
    "0-100",
    "a-b",
    "7900.5-7949",
    "+7900-7949",
    "123456-123457",
    undefined,
    null,
    7900,
    [7900, 7949],
    {},
  ];

  it.each(good)("parseProxyPortRange(%j) ⇒ %j", (text, want) => {
    expect(parseProxyPortRange(text)).toEqual(want);
  });
  it.each(bad.map((b) => [b] as const))("parseProxyPortRange(%j) ⇒ undefined", (text) => {
    expect(parseProxyPortRange(text)).toBeUndefined();
  });

  it("format ↔ parse round-trips and the default text is the canonical default range", () => {
    expect(formatProxyPortRange([7900, 7949])).toBe(PROXY_DEFAULT_PORT_RANGE_TEXT);
    expect(parseProxyPortRange(PROXY_DEFAULT_PORT_RANGE_TEXT)).toEqual([...PROXY_DEFAULT_PORT_RANGE]);
  });

  it("proxyRangeContainsPort is inclusive and integer-only", () => {
    expect(proxyRangeContainsPort([7900, 7949], 7900)).toBe(true);
    expect(proxyRangeContainsPort([7900, 7949], 7949)).toBe(true);
    expect(proxyRangeContainsPort([7900, 7949], 7899)).toBe(false);
    expect(proxyRangeContainsPort([7900, 7949], 7950)).toBe(false);
    expect(proxyRangeContainsPort([7900, 7949], 7900.5)).toBe(false);
  });

  it("the settings parser's parity copy accepts/rejects EXACTLY what protocol's parser does", () => {
    // `undefined` is "leaf absent" for the block parser (default, NO warning) — covered separately
    expect(parseWebHubProxyBlock({ portRange: undefined }, 0, 0)).toEqual({
      proxy: DEFAULT_WEBHUB_PROXY_SETTINGS,
      warnings: [],
    });
    for (const text of [...good.map(([t]) => t), ...bad.filter((b) => b !== undefined)]) {
      const want = parseProxyPortRange(text);
      const got = parseWebHubProxyBlock({ portRange: text }, 0, 0);
      if (want === undefined) {
        expect(got.proxy.portRange, JSON.stringify(text)).toBe(PROXY_DEFAULT_PORT_RANGE_TEXT);
        expect(got.warnings, JSON.stringify(text)).toEqual(["port-range-invalid"]);
      } else {
        expect(got.proxy.portRange, JSON.stringify(text)).toBe(formatProxyPortRange(want));
        expect(got.warnings, JSON.stringify(text)).toEqual([]);
      }
    }
  });
});

describe("hub caps (plan §5)", () => {
  it("names the two caps", () => {
    expect(PROXY_HUB_CAP).toBe("proxy.v1");
    expect(PROXY_LAN_HUB_CAP).toBe("proxy.lan.v1");
  });
});

describe("webHub.proxy settings (plan §5: off by default, at most three leaves, non-live)", () => {
  it("the settings defaults mirror the protocol constants (settings.ts cannot value-import them)", () => {
    expect(DEFAULT_WEBHUB_PROXY_SETTINGS).toEqual({
      enabled: false,
      portRange: PROXY_DEFAULT_PORT_RANGE_TEXT,
      maxProxies: PROXY_DEFAULT_MAX_PROXIES,
    });
    expect(DEFAULT_SETTINGS.webHub.proxy).toEqual(DEFAULT_WEBHUB_PROXY_SETTINGS);
    expect(DEFAULT_SETTINGS.webHub.proxy?.enabled).toBe(false);
    expect(parseProxyPortRange(DEFAULT_WEBHUB_PROXY_SETTINGS.portRange)).toEqual([...PROXY_DEFAULT_PORT_RANGE]);
  });

  it("parseWebHubSettings / loadSettings carry the block; missing / non-object ⇒ defaults (no warnings)", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1]]) {
      expect(parseWebHubSettings({ proxy: input }).proxy, JSON.stringify(input)).toEqual(DEFAULT_WEBHUB_PROXY_SETTINGS);
      expect(parseWebHubProxyBlock(input, 7878, 7879)).toEqual({
        proxy: DEFAULT_WEBHUB_PROXY_SETTINGS,
        warnings: [],
      });
    }
    expect(parseWebHubSettings({}).proxy).toEqual(DEFAULT_WEBHUB_PROXY_SETTINGS);
    expect(parseWebHubSettings(undefined).proxy).toEqual(DEFAULT_WEBHUB_PROXY_SETTINGS);
    expect(loadSettings({}).webHub.proxy).toEqual(DEFAULT_WEBHUB_PROXY_SETTINGS);
    // fresh copies — a caller mutating the parsed block never corrupts the defaults
    const a = parseWebHubSettings(undefined).proxy!;
    a.enabled = true;
    expect(DEFAULT_WEBHUB_PROXY_SETTINGS.enabled).toBe(false);
  });

  it("keeps valid fields (canonicalized range) and loads through loadSettings", () => {
    const s = loadSettings({ webHub: { proxy: { enabled: true, portRange: " 8100-8109 ", maxProxies: 4 } } });
    expect(s.webHub.proxy).toEqual({ enabled: true, portRange: "8100-8109", maxProxies: 4 });
    expect(
      parseWebHubProxyBlock({ enabled: true, portRange: "8100-8109", maxProxies: 4 }, 7878, 7879).warnings,
    ).toEqual([]);
  });

  it("enabled must be a real boolean; garbage ⇒ false", () => {
    for (const garbage of ["true", 1, "yes", null, [], {}]) {
      expect(parseWebHubProxyBlock({ enabled: garbage }, 7878, 7879).proxy.enabled, JSON.stringify(garbage)).toBe(
        false,
      );
    }
    expect(parseWebHubProxyBlock({ enabled: true }, 7878, 7879).proxy.enabled).toBe(true);
  });

  it("maxProxies ∉ 1..16 or non-integer ⇒ default + warning", () => {
    for (const bad of [0, 17, -1, 1.5, "8", Number.NaN, Number.POSITIVE_INFINITY, null, [], {}]) {
      const r = parseWebHubProxyBlock({ maxProxies: bad }, 7878, 7879);
      expect(r.proxy.maxProxies, JSON.stringify(bad)).toBe(PROXY_DEFAULT_MAX_PROXIES);
      expect(r.warnings, JSON.stringify(bad)).toEqual(["max-proxies-invalid"]);
    }
    for (const ok of [1, 8, 16]) {
      const r = parseWebHubProxyBlock({ maxProxies: ok }, 7878, 7879);
      expect(r.proxy.maxProxies).toBe(ok);
      expect(r.warnings).toEqual([]);
    }
  });

  it("a range overlapping the hub port or the LAN port ⇒ default + warning (port 0 = ephemeral never overlaps)", () => {
    expect(parseWebHubProxyBlock({ portRange: "8000-8010" }, 8005, 7879)).toEqual({
      proxy: { ...DEFAULT_WEBHUB_PROXY_SETTINGS },
      warnings: ["port-range-overlap"],
    });
    expect(parseWebHubProxyBlock({ portRange: "8000-8010" }, 7878, 8010).warnings).toEqual(["port-range-overlap"]);
    expect(parseWebHubProxyBlock({ portRange: "8000-8010" }, 7878, 8000).warnings).toEqual(["port-range-overlap"]);
    // adjacent but not overlapping
    expect(parseWebHubProxyBlock({ portRange: "8000-8010" }, 7999, 8011).warnings).toEqual([]);
    // ephemeral hub port
    expect(parseWebHubProxyBlock({ portRange: "8000-8010" }, 0, 7879).warnings).toEqual([]);
    // end-to-end: webHub.port and webHub.lan.port come from the same block
    const viaSettings = parseWebHubSettings({ port: 8005, proxy: { enabled: true, portRange: "8000-8010" } });
    expect(viaSettings.proxy).toEqual({ enabled: true, portRange: "7900-7949", maxProxies: 8 });
    const viaLan = parseWebHubSettings({ lan: { port: 8001 }, proxy: { enabled: true, portRange: "8000-8010" } });
    expect(viaLan.proxy?.portRange).toBe("7900-7949");
  });

  it("a malformed leaf only resets that leaf, never the others", () => {
    const r = parseWebHubProxyBlock({ enabled: true, portRange: "nope", maxProxies: 3 }, 7878, 7879);
    expect(r.proxy).toEqual({ enabled: true, portRange: "7900-7949", maxProxies: 3 });
    expect(r.warnings).toEqual(["port-range-invalid"]);
    const both = parseWebHubProxyBlock({ portRange: "x", maxProxies: 99 }, 7878, 7879);
    expect(both.warnings).toEqual(["port-range-invalid", "max-proxies-invalid"]);
  });

  it("SETTING_SPECS has exactly the three leaves, in order, non-live, with the §5 domains", () => {
    expect(Object.keys(SETTING_SPECS).filter((k) => k.startsWith("webHub.proxy."))).toEqual([
      "webHub.proxy.enabled",
      "webHub.proxy.portRange",
      "webHub.proxy.maxProxies",
    ]);
    for (const key of ["webHub.proxy.enabled", "webHub.proxy.portRange", "webHub.proxy.maxProxies"]) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.time, key).toBeUndefined();
      expect(spec.path, key).toBe(key);
      expect(spec.description, key).toMatch(/\/reload/);
      expect(currentOf(DEFAULT_SETTINGS, spec), key).toBeDefined();
    }
    expect(SETTING_SPECS["webHub.proxy.enabled"]).toMatchObject({ kind: "boolean" });
    expect(SETTING_SPECS["webHub.proxy.portRange"]).toMatchObject({ kind: "string" });
    expect(SETTING_SPECS["webHub.proxy.portRange"]).not.toHaveProperty("csv");
    expect(SETTING_SPECS["webHub.proxy.maxProxies"]).toMatchObject({ kind: "number", min: 1, max: 16, integer: true });
    expect(defaultOf(SETTING_SPECS["webHub.proxy.enabled"]!)).toBe(false);
    expect(defaultOf(SETTING_SPECS["webHub.proxy.portRange"]!)).toBe("7900-7949");
    expect(defaultOf(SETTING_SPECS["webHub.proxy.maxProxies"]!)).toBe(8);
    // LAN follows webHub.lan (Q2): there is NO proxy-specific LAN leaf
    expect(Object.keys(SETTING_SPECS).some((k) => k.startsWith("webHub.proxy.") && /lan/i.test(k))).toBe(false);
  });

  it("the editor's parseSettingValue enforces the maxProxies domain", () => {
    const spec = SETTING_SPECS["webHub.proxy.maxProxies"]!;
    expect(parseSettingValue(spec, "16")).toMatchObject({ ok: true, stored: 16 });
    expect(parseSettingValue(spec, "1")).toMatchObject({ ok: true, stored: 1 });
    expect(parseSettingValue(spec, "0").ok).toBe(false);
    expect(parseSettingValue(spec, "17").ok).toBe(false);
    expect(parseSettingValue(spec, "2.5").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["webHub.proxy.enabled"]!, "on")).toMatchObject({ ok: true, stored: true });
  });
});

describe("ports.ts frozen types (compile-time + shape)", () => {
  it("HubConfig.proxy is an optional { portRange: [lo,hi]; maxProxies } and the base config stays valid without it", () => {
    const base: HubConfig = {
      v: 1,
      home: "/h",
      port: 0,
      idleExitMinutes: 1,
      pluginVersion: "0",
      buildId: "b",
    };
    expect("proxy" in base).toBe(false);
    const withProxy: HubConfig = { ...base, proxy: { portRange: [7900, 7949], maxProxies: 8 } };
    expect(withProxy.proxy).toEqual({ portRange: [7900, 7949], maxProxies: 8 });
    // a settings-derived range is assignable to the config tuple
    const parsed = parseProxyPortRange(DEFAULT_WEBHUB_PROXY_SETTINGS.portRange);
    expect(parsed).toBeDefined();
    const fromSettings: HubConfig = { ...base, proxy: { portRange: parsed!, maxProxies: 8 } };
    expect(fromSettings.proxy?.portRange).toEqual([7900, 7949]);
  });

  it("ProxyService / ProxyRoutes members are exactly the frozen surface (type-level `satisfies`)", () => {
    const service = {
      currentSeq: () => 0,
      revokedSince: () => false as boolean | "gap",
      open: async () => ({
        ok: false as const,
        status: 503 as const,
        error: "E_PROXY_UNAVAILABLE" as const,
        reason: "closing" as const,
      }),
      list: () => ({ items: [], policy: { maxProxies: 8, portRange: [7900, 7949] as const, lan: false } }),
      stop: async () => ({ ok: false as const, code: "E_NOT_FOUND" as const }),
      revoke: () => undefined,
      activeConnections: () => 0,
      dispose: async () => undefined,
    } satisfies ProxyService;
    const routes = { handle: async () => false } satisfies ProxyRoutes;
    expect(Object.keys(service).sort()).toEqual(
      ["activeConnections", "currentSeq", "dispose", "list", "open", "revoke", "revokedSince", "stop"].sort(),
    );
    expect(Object.keys(routes)).toEqual(["handle"]);
  });

  it("every ProxyDenyReason literal is a valid ProxyDenyReason", () => {
    const reasons: ProxyDenyReason[] = [...PROXY_DENY_REASONS];
    expect(reasons).toHaveLength(19);
  });
});

describe("UI-side contract mirrors (src/web-hub/ui/src/logic/contract.js)", () => {
  it("API.proxy* are the protocol constants (imported, never hand-copied)", () => {
    expect(web.API.proxyOpen).toBe(PROXY_OPEN_PATH);
    expect(web.API.proxyList).toBe(PROXY_LIST_PATH);
    expect(web.API.proxyStop).toBe(PROXY_STOP_PATH);
    expect(Object.isFrozen(web.API)).toBe(true);
  });

  it("PROXY_CAPS selects proxy.v1 for token auth and proxy.lan.v1 for password auth", () => {
    expect({ ...web.PROXY_CAPS }).toEqual({ token: "proxy.v1", password: "proxy.lan.v1" });
    expect(web.PROXY_CAPS.token).toBe(PROXY_HUB_CAP);
    expect(web.PROXY_CAPS.password).toBe(PROXY_LAN_HUB_CAP);
  });

  it("the deny-reason set and the conflict reason mirror the protocol", () => {
    expect([...web.PROXY_DENY_REASON_SET]).toEqual([...PROXY_DENY_REASONS]);
    expect(Object.isFrozen(web.PROXY_DENY_REASON_SET)).toBe(true);
    expect(web.PROXY_COOKIE_CONFLICT).toBe(PROXY_COOKIE_CONFLICT_REASON);
    expect(web.PROXY_CLIENT_TIMEOUT_MS).toBe(15_000);
  });
});
