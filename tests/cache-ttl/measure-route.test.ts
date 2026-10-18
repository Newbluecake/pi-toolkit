import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { measureEndpointSuffix, measureRouteKey } from "../../src/cache-ttl/measure-route.js";

const base = {
  api: "anthropic-messages" as const,
  url: "https://relay.example/anthropic/v1/messages?z=2&a=1",
  wireModel: "claude-test",
  effectiveTier: "ephemeral" as const,
};
const key = (url: string) => measureRouteKey({ ...base, url });

describe("measurement route digest and redacted label", () => {
  it("hashes the complete normalised tuple with SHA-256; strips suffix and trailing slash", () => {
    expect(key(base.url).key).toBe(
      `sha256:${createHash("sha256")
        .update(
          JSON.stringify([
            base.api,
            "https://relay.example",
            "/anthropic",
            [
              ["a", "1"],
              ["z", "2"],
            ],
            base.wireModel,
            base.effectiveTier,
          ]),
        )
        .digest("hex")}`,
    );
    expect(key("https://relay.example/anthropic//v1/messages?z=2&a=1").key).toBe(key(base.url).key);
  });
  it("normalises origin/default port/userinfo and query order; fragments never identify a route", () => {
    expect(key("HTTPS://user:password@RELAY.EXAMPLE:443/anthropic/v1/messages?a=1&z=2#secret").key).toBe(
      key(base.url).key,
    );
    expect(key("https://relay.example/anthropic/v1/messages?z=2&a=1&a=0").key).toBe(
      key("https://relay.example/anthropic/v1/messages?a=0&a=1&z=2").key,
    );
    expect(key("http://relay.example:80/anthropic/v1/messages").key).toBe(
      key("http://relay.example/anthropic/v1/messages").key,
    );
  });
  it("keeps all identity-bearing differences, including duplicate query params", () => {
    const original = key(base.url).key;
    for (const url of [
      "http://relay.example/anthropic/v1/messages?z=2&a=1",
      "https://relay.example:8443/anthropic/v1/messages?z=2&a=1",
      "https://other.example/anthropic/v1/messages?z=2&a=1",
      "https://relay.example/other/v1/messages?z=2&a=1",
      "https://relay.example/anthropic/v1/messages?z=2&a=2",
      "https://relay.example/anthropic/v1/messages?z=2&a=1&a=1",
    ])
      expect(key(url).key).not.toBe(original);
    expect(measureRouteKey({ ...base, wireModel: "other" }).key).not.toBe(original);
    expect(measureRouteKey({ ...base, effectiveTier: "ephemeral-1h" }).key).not.toBe(original);
  });
  it.each(["anthropic-messages", "openai-responses", "openai-completions"] as const)(
    "uses the exact per-profile suffix (%s)",
    (api) => {
      const url = `https://relay.example/v1${measureEndpointSuffix(api)}`;
      expect(measureRouteKey({ ...base, api, url }).key).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(() => measureRouteKey({ ...base, api, url: `${url}/` })).toThrow("unsupported measurement endpoint");
    },
  );
  it("persists no URL, credentials, query value or token-like segment, and displays ≤2 base path segments", () => {
    const result = key(
      "https://user:password@Relay.Example/anthropic/sk-secret-value-token/more/path/v1/messages?api_key=private-query-value&beta=true",
    );
    expect(result.label).toBe("anthropic-messages · relay.example · /anthropic/…?api_key=…&beta=… · claude-test");
    for (const secret of ["user", "password", "sk-secret", "private-query-value", "more", "true", "https://"])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(key("https://relay.example/123456789abcdef/v1/messages").label).toContain("/…");
    expect(key("https://relay.example/secret%2Ftoken/v1/messages").label).toContain("/…");
  });
  it("refuses malformed, wrong-suffix and non-HTTP URLs without echoing them", () => {
    for (const url of ["not a URL", "https://relay.example/responses", "file:///v1/messages"])
      expect(() => key(url)).toThrow();
  });
});
