// @vitest-environment happy-dom
/** G integration: honest transport → auth composable → mounted LoginView; no component fetches. */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePasswordAuth } from "../../../src/web-hub/ui/src/composables/usePasswordAuth.js";
import LoginView from "../../../src/web-hub/ui/src/components/shell/LoginView.vue";
import LoginSecondFactor from "../../../src/web-hub/ui/src/components/shell/LoginSecondFactor.vue";
import type { PasswordAuthDeps } from "../../../src/web-hub/ui/src/composables/usePasswordAuth.js";
import type { Lan2faChallenge } from "../../../src/web-hub/protocol/lan-2fa.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
class ES {
  static opened = 0;
  readyState = 0;
  constructor() {
    ES.opened++;
  }
  addEventListener() {}
  close() {}
}
const ch = (): Lan2faChallenge => ({
  error: "E_2FA",
  methods: ["totp", "recovery", "feishu"],
  feishu: "sent",
  expiresAt: Date.now() + 300000,
});
const response = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
});
function rig(cap = true, waitBody?: { state: string }) {
  const calls: string[] = [];
  let result: unknown = { error: "E_2FA_CODE", attemptsLeft: 5 };
  const fetch: PasswordAuthDeps["fetch"] = async (url, opts) => {
    calls.push(url);
    if (url === "/api/login") return response(ch(), 401);
    if (url === "/api/login/2fa/wait") {
      if (waitBody) return response(waitBody);
      return new Promise((_resolve, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    }
    if (url === "/api/login/2fa") return response(result, (result as { ok?: boolean }).ok ? 200 : 401);
    return response({ ok: true });
  };
  const auth = usePasswordAuth({
    deps: {
      fetch,
      EventSource: ES as unknown as PasswordAuthDeps["EventSource"],
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
    },
    setTimeout,
    clearTimeout,
    secondFactorEnabled: () => cap,
  });
  const transport = auth.createTransport({ onMessage() {}, onConn() {} });
  cleanups.push(() => {
    auth.dispose();
    transport.close();
  });
  return {
    auth,
    calls,
    result: (value: unknown) => {
      result = value;
    },
  };
}
const creds = { username: "alice", password: "secret-password" };
describe("LAN-G auth flow wiring", () => {
  it("no cap: never mounts a challenge or polls; cancels the unsupported challenge", async () => {
    const h = rig(false);
    await h.auth.submit(creds);
    expect(h.auth.challenge.value).toBeNull();
    expect(h.calls).toEqual(["/api/login", "/api/login/2fa/cancel"]);
    expect(h.auth.error.value?.key).toBe("errors.unknown");
  });
  it("polls Feishu immediately alongside TOTP/recovery; error/lock props, success and no cancel-after-login", async () => {
    const h = rig();
    ES.opened = 0;
    await h.auth.submit(creds);
    const challenge = h.auth.challenge.value;
    expect(challenge).not.toBeNull();
    expect(h.calls).toEqual(["/api/login", "/api/login/2fa/wait"]);
    void h.auth.waitApproval();
    expect(h.calls.filter((p) => p.endsWith("/wait"))).toHaveLength(1);
    await h.auth.submitSecondFactor({ method: "totp", code: "123456" });
    expect(h.auth.attemptsLeft.value).toBe(5);
    expect(h.auth.challenge.value).toBe(challenge);
    h.result({ error: "E_2FA_METHOD_LOCKED", retryAfterMs: 60000 });
    await h.auth.submitSecondFactor({ method: "totp", code: "123456" });
    expect(h.auth.lockedUntil.value).toBeGreaterThan(Date.now() + 59000);
    h.result({ ok: true, initialPassword: false });
    await h.auth.submitSecondFactor({ method: "recovery", code: "0123456789AB" });
    expect(ES.opened).toBe(1);
    expect(h.auth.challenge.value).toBeNull();
    expect(h.calls).not.toContain("/api/login/2fa/cancel");
    expect(h.auth.error.value).toBeNull();
  });
  it.each(["denied", "expired"])("%s wait returns to password form and cancels the dead challenge", async (state) => {
    const h = rig(true, { state });
    await h.auth.submit(creds);
    await vi.waitFor(() => expect(h.auth.challenge.value).toBeNull());
    expect(h.auth.error.value?.key).toBe(`login.2fa.${state}`);
    expect(h.calls).toContain("/api/login/2fa/cancel");
  });
  it("explicit cancel and dispose abort the polling flow and clear all view state", async () => {
    const h = rig();
    await h.auth.submit(creds);
    await h.auth.cancelSecondFactor();
    expect(h.auth.challenge.value).toBeNull();
    expect(h.auth.busy.value).toBe(false);
    expect(h.calls.filter((p) => p.endsWith("/cancel"))).toHaveLength(1);
    await h.auth.submit(creds);
    h.auth.dispose();
    expect(h.auth.challenge.value).toBeNull();
    expect(h.calls.filter((p) => p.endsWith("/cancel"))).toHaveLength(2);
  });
  it("LoginView mounts the component only behind the cap; unmount of an abandoned challenge emits cancel", () => {
    const props = { plaintext: false, busy: false, error: null, initialPasswordHint: false, challenge: ch() };
    const off = mount(LoginView, { props });
    expect(off.findComponent(LoginSecondFactor).exists()).toBe(false);
    off.unmount();
    expect(off.emitted("factorCancel")).toBeUndefined();
    const on = mount(LoginView, { props: { ...props, secondFactorEnabled: true } });
    expect(on.findComponent(LoginSecondFactor).exists()).toBe(true);
    expect(on.find("#login-password").exists()).toBe(false);
    on.unmount();
    expect(on.emitted("factorCancel")).toHaveLength(1);
  });
});
