// @vitest-environment node
/**
 * `checks-common.ts`'s pre-login 401 allowlist (vue-plan.md v2.1 §3.9, §4.4 — W3 integration
 * fix). Password mode's own auth-recovery protocol legitimately probes `GET /api/session` and
 * opens an `EventSource` at `/api/events` *before* any credentials exist, both surfacing as a
 * bare `401` on the network and as a browser-generated `console.error`-shaped message. Only
 * those two same-origin paths, and only a bare `401`, may be allowlisted — everything else
 * (other status codes, other paths, a 401 elsewhere) must still fail the check.
 */
import { describe, expect, it } from "vitest";
import { API } from "../../../src/web-hub/web/contract.js";
import {
  isExpectedPreLoginAuthProbe,
  isExpectedPreLoginConsole401,
  isExpectedReloadAbort,
} from "../../../scripts/web-hub/visual/checks-common.js";

describe("allowlisted paths stay in sync with the real API contract", () => {
  it("the allowlist's hardcoded literals equal API.session / API.events", () => {
    expect(isExpectedPreLoginAuthProbe({ url: `http://x${API.session}`, reason: "HTTP 401" })).toBe(true);
    expect(isExpectedPreLoginAuthProbe({ url: `http://x${API.events}`, reason: "HTTP 401" })).toBe(true);
  });
});

describe("isExpectedPreLoginAuthProbe (no-failed-requests allowlist)", () => {
  it("allows a bare HTTP 401 on /api/session", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/session", reason: "HTTP 401" })).toBe(true);
  });

  it("allows a bare HTTP 401 on /api/events", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/events", reason: "HTTP 401" })).toBe(true);
  });

  it("rejects a 401 on any other path", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/subscribe", reason: "HTTP 401" })).toBe(false);
  });

  it("rejects a non-401 status on an otherwise-allowlisted path", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/session", reason: "HTTP 500" })).toBe(false);
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/session", reason: "HTTP 403" })).toBe(false);
  });

  it("rejects a network-level failure reason even on an allowlisted path", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "http://127.0.0.1:9/api/events", reason: "net::ERR_ABORTED" })).toBe(
      false,
    );
  });

  it("rejects a malformed URL", () => {
    expect(isExpectedPreLoginAuthProbe({ url: "not a url", reason: "HTTP 401" })).toBe(false);
  });
});

describe("isExpectedReloadAbort (no-failed-requests allowlist for theme-reload SSE teardown)", () => {
  it("the allowlisted literal equals the real API.events path", () => {
    expect(isExpectedReloadAbort({ url: `http://x${API.events}`, reason: "net::ERR_ABORTED" })).toBe(true);
  });

  it("allows a net::ERR_ABORTED on /api/events (theme-reload tearing down the in-flight SSE)", () => {
    expect(isExpectedReloadAbort({ url: "http://127.0.0.1:9/api/events", reason: "net::ERR_ABORTED" })).toBe(true);
  });

  it("rejects a net::ERR_ABORTED on any other path", () => {
    expect(isExpectedReloadAbort({ url: "http://127.0.0.1:9/api/session", reason: "net::ERR_ABORTED" })).toBe(false);
    expect(isExpectedReloadAbort({ url: "http://127.0.0.1:9/assets/index.js", reason: "net::ERR_ABORTED" })).toBe(
      false,
    );
  });

  it("rejects any other failure reason on /api/events, including a real connection failure", () => {
    expect(isExpectedReloadAbort({ url: "http://127.0.0.1:9/api/events", reason: "HTTP 401" })).toBe(false);
    expect(isExpectedReloadAbort({ url: "http://127.0.0.1:9/api/events", reason: "net::ERR_CONNECTION_REFUSED" })).toBe(
      false,
    );
  });

  it("rejects a malformed URL", () => {
    expect(isExpectedReloadAbort({ url: "not a url", reason: "net::ERR_ABORTED" })).toBe(false);
  });
});

describe("isExpectedPreLoginConsole401 (no-console-errors allowlist)", () => {
  it("allows the browser-generated resource-load-failure message for /api/session", () => {
    expect(
      isExpectedPreLoginConsole401(
        "Failed to load resource: the server responded with a status of 401 (Unauthorized) [http://127.0.0.1:9/api/session]",
      ),
    ).toBe(true);
  });

  it("allows the same message shape for /api/events", () => {
    expect(
      isExpectedPreLoginConsole401(
        "Failed to load resource: the server responded with a status of 401 (Unauthorized) [http://127.0.0.1:9/api/events]",
      ),
    ).toBe(true);
  });

  it("rejects the same message shape for any other path", () => {
    expect(
      isExpectedPreLoginConsole401(
        "Failed to load resource: the server responded with a status of 401 (Unauthorized) [http://127.0.0.1:9/api/subscribe]",
      ),
    ).toBe(false);
  });

  it("rejects a differently-worded console error", () => {
    expect(isExpectedPreLoginConsole401("Uncaught TypeError: x is not a function")).toBe(false);
  });

  it("rejects a message with no [url] suffix", () => {
    expect(
      isExpectedPreLoginConsole401("Failed to load resource: the server responded with a status of 401 (Unauthorized)"),
    ).toBe(false);
  });
});
