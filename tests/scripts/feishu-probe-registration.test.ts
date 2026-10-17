// P1 end-to-end state-machine tests with stub fetch, fake time, and private temp files.
// These are NOT tenant observations; no request reaches Feishu/Lark.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P1 } from "../../scripts/dev/feishu-probe/steps.ts";
import { Probe, Unknown } from "../../scripts/dev/feishu-probe/runtime.ts";
import { ProbeError, failureInfo, missingScopes } from "../../scripts/dev/feishu-probe/errors.ts";
import { allowedUrl, redact } from "../../scripts/dev/feishu-probe/safety.ts";

type Reply = { status?: number; body: unknown } | Error;
const success = {
  client_id: "cli_test",
  client_secret: "client-secret-canary",
  user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
};
let p: Probe, temp: string, waits: number[], calls: { url: string; action: string; at: number }[];
let begin: Record<string, unknown>, replies: Reply[];
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "feishu-probe-P1-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T08:16:00Z"));
  p = new Probe(5000);
  p.current = "P1";
  p.credentialDir = join(temp, "private");
  waits = [];
  calls = [];
  replies = [];
  begin = {
    device_code: "device-code-canary",
    verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=TEST",
    interval: 1,
    expires_in: 60,
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(p, "ask").mockResolvedValue("");
  vi.spyOn(p, "wait").mockImplementation(async (ms) => {
    waits.push(ms);
    vi.setSystemTime(Date.now() + ms);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const action = new URLSearchParams(options.body as URLSearchParams).get("action")!;
      calls.push({ url, action, at: Date.now() });
      const reply: Reply =
        action === "begin" ? { body: begin } : (replies.shift() ?? new Error("unexpected request: no stub left"));
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }),
  );
});
afterEach(async () => {
  p.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(temp, { recursive: true, force: true });
});
async function saved() {
  return JSON.parse(await readFile(join(p.credentialDir, "credentials.json"), "utf8"));
}
describe("P1 device registration over stub fetch", () => {
  it("accepts HTTP 400 authorization_pending then credentials, and displays open.feishu.cn launcher safely", async () => {
    replies = [{ status: 400, body: { error: "authorization_pending" } }, { body: success }];
    await P1(p, false);
    expect(calls.map((c) => c.action)).toEqual(["begin", "poll", "poll"]);
    expect(waits).toEqual([1000, 1000]);
    expect((await saved()).appSecret).toBe(success.client_secret);
    expect((await stat(join(p.credentialDir, "credentials.json"))).mode & 0o777).toBe(0o600);
    const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(printed).toContain("https://open.feishu.cn/page/launcher?user_code=TEST");
    for (const secret of ["device-code-canary", success.client_secret, "ou_owner"])
      expect(printed).not.toContain(secret);
    const report = JSON.stringify(p.report);
    expect(report).not.toContain("user_code=TEST");
    expect(report).not.toContain(success.client_secret);
  });
  it("honors HTTP 400 slow_down by adding five seconds", async () => {
    replies = [{ status: 400, body: { error: "slow_down" } }, { body: success }];
    await P1(p, false);
    expect(waits).toEqual([1000, 6000]);
    expect(calls[2]!.at - calls[1]!.at).toBe(6000);
  });
  it("switches accounts domain and immediately re-polls with the same device code", async () => {
    replies = [
      { status: 400, body: { error: "authorization_pending", user_info: { tenant_brand: "lark" } } },
      { body: { ...success, user_info: { ...success.user_info, tenant_brand: "lark" } } },
    ];
    await P1(p, false);
    expect(calls[1]!.url).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(calls[2]!.url).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
    expect(calls[2]!.at).toBe(calls[1]!.at);
    expect(waits).toEqual([1000]);
    expect((await saved()).brand).toBe("lark");
    const forms = vi
      .mocked(fetch)
      .mock.calls.slice(1)
      .map((c) => new URLSearchParams(c[1]!.body as URLSearchParams).get("device_code"));
    expect(forms).toEqual(["device-code-canary", "device-code-canary"]);
  });
  it("stops at expiry without persisting credentials", async () => {
    begin.expires_in = 3;
    begin.interval = 2;
    replies = [{ status: 400, body: { error: "authorization_pending" } }];
    await expect(P1(p, false)).rejects.toBeInstanceOf(Unknown);
    expect(waits).toEqual([2000, 1000]);
    expect(calls).toHaveLength(2);
    await expect(saved()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retries transient network errors with bounded backoff, then succeeds", async () => {
    replies = [new TypeError("secret-in-network-error"), new TypeError("secret-in-network-error"), { body: success }];
    await P1(p, false);
    expect(waits).toEqual([1000, 1000, 2000]);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(p.report)).not.toContain("secret-in-network-error");
    expect(p.report.steps.P1.observations.filter((o: any) => o.kind === "registration-retry")).toHaveLength(2);
  });
  it("caps consecutive transient retries rather than spinning until expiry", async () => {
    replies = Array.from({ length: 5 }, () => new TypeError("offline"));
    await expect(P1(p, false)).rejects.toMatchObject({ kind: "unreachable" });
    expect(calls).toHaveLength(6);
    expect(waits).toEqual([1000, 1000, 2000, 4000, 8000]);
    await expect(saved()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("treats the documented brand-switch body (no error, no credentials) as a switch, not a failure", async () => {
    replies = [
      { body: { user_info: { tenant_brand: "lark" } } },
      { body: { ...success, user_info: { ...success.user_info, tenant_brand: "lark" } } },
    ];
    await P1(p, false);
    expect(calls[2]!.url).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
    expect(calls[2]!.at).toBe(calls[1]!.at);
    expect((await saved()).brand).toBe("lark");
  });
  it("keeps polling on an empty {} body (authorize redirect window, per multica)", async () => {
    replies = [{ body: {} }, { status: 400, body: { error: "" } }, { body: success }];
    await P1(p, false);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1000, 1000, 1000]);
  });
  it.each([null, { error: "not-a-device-flow-error" }, { client_id: "cli_test" }, { client_secret: "x" }])(
    "rejects unknown/garbage poll body %j",
    async (body) => {
      replies = [{ status: 400, body }];
      await expect(P1(p, false)).rejects.toBeInstanceOf(ProbeError);
      await expect(saved()).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("trusts complete credential fields rather than requiring HTTP 200", async () => {
    replies = [{ status: 400, body: success }];
    await P1(p, false);
    expect((await saved()).ownerOpenId).toBe("ou_owner");
  });
  it("keeps display URL validation separate from registration POST admission", () => {
    for (const url of ["https://open.feishu.cn/page/launcher?user_code=TEST", "https://accounts.larksuite.com/verify"])
      expect(allowedUrl(url, "display").protocol).toBe("https:");
    for (const url of [
      "http://open.feishu.cn/qr",
      "https://x@open.feishu.cn/qr",
      "https://open.feishu.cn:444/qr",
      "https://open.feishu.cn.evil.test/qr",
      "https://notfeishu.cn/qr",
    ])
      expect(() => allowedUrl(url, "display")).toThrow("destination-refused");
    expect(() => allowedUrl("https://open.feishu.cn/page/launcher", "accounts")).toThrow("destination-refused");
  });
  it("extracts only scope-shaped diagnostic tokens, preserving them without arbitrary msg text/secrets", () => {
    const msg =
      "Access denied: require [im:message.reactions:write_only, im:resource, contact:user.id:readonly]. secret:canary https://im:private/path im:secret_value im:private_scope arbitrary words";
    const scopes = missingScopes(msg, ["private_scope"]);
    expect(scopes).toEqual(["im:message.reactions:write_only", "im:resource", "contact:user.id:readonly"]);
    const safe = JSON.stringify(redact({ msg, scopes }));
    expect(safe).toContain("im:resource");
    expect(safe).not.toContain("Access denied");
    expect(safe).not.toContain("private_scope");
    expect(failureInfo(new ProbeError("credential", "file-mode"))).toEqual({
      reason: "credential",
      check: "file-mode",
    });
    expect(failureInfo(new Error("app_secret=canary"))).toEqual({ reason: "local-io" });
  });
});
