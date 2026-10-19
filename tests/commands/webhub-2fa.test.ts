/**
 * LAN security r2 §5.8 / §10 row F: agent-side `/webhub 2fa` command (`agent/twofa-cmd.ts` +
 * `agent/twofa-prompt.ts`).
 *
 * Proves the r1-#4 gate: every secret-bearing subcommand is refused BEFORE any `tfa_req` frame
 * or QR/code rendering when the invocation is a web-captured one (`mode:"tui"` +
 * `webInvocation:true` — exactly what `command-capture.ts`'s proxy produces, INCLUDING when the
 * web command policy would allow `/webhub`: the gate never consults policy), and that the
 * refusal output carries no secret. Plus the enroll/feishu/recovery/reset/forget-ips/repair
 * flows, codes-printed-once, and the old-hub cap gate.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ExtensionMode } from "@earendil-works/pi-coding-agent";
import {
  fetchTfaStatus,
  formatTfaError,
  formatTfaStatusLines,
  requestTfa,
  runTwofaCommand,
  type TwofaCommandDeps,
} from "../../src/web-hub/agent/twofa-cmd.js";
import { runTwofaEnrollPrompt } from "../../src/web-hub/agent/twofa-prompt.js";
import { RECOVERY_CODE_RE, type TfaReqFrame, type TfaResFrame } from "../../src/web-hub/protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../../src/web-hub/protocol/version.js";

const SECRET_B32 = "JBSWY3DPEHPK3PXP";
const OTPAUTH_URI = `otpauth://totp/pi-webhub?secret=${SECRET_B32}&issuer=pi-webhub`;
const RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `ABC${String(i).padStart(9, "0")}`);

function okData(data: Extract<TfaResFrame, { ok: true }>["data"], rid = "x"): TfaResFrame {
  return { t: "tfa_res", rid, ok: true, data };
}
function fail(code: string, message: string, rid = "x"): TfaResFrame {
  return { t: "tfa_res", rid, ok: false, code, message };
}

function fakeCtx(mode: ExtensionMode = "tui", webInvocation = false): ExtensionCommandContext {
  return {
    mode,
    ui: { notify: () => {} },
    ...(webInvocation ? { webInvocation: true } : {}),
  } as unknown as ExtensionCommandContext;
}

interface Harness {
  deps: TwofaCommandDeps;
  sent: TfaReqFrame[];
  notes: Array<{ message: string; level: string }>;
  enrollments: Array<{ otpauthUri: string; secretB32: string }>;
  codesShown: string[][];
  promptCalls: number;
  ownerChecks: number;
}

function harness(
  script: TfaResFrame[] = [],
  opts: { cap?: boolean; code?: string | undefined; owner?: boolean; throwOnRequest?: boolean } = {},
): Harness {
  const queue = [...script];
  const sent: TfaReqFrame[] = [];
  const notes: Harness["notes"] = [];
  const enrollments: Harness["enrollments"] = [];
  const codesShown: Harness["codesShown"] = [];
  let promptCalls = 0;
  let ownerChecks = 0;
  const deps: TwofaCommandDeps = {
    hasCap: (c) => (opts.cap ?? true) && c === LAN_2FA_HUB_CAP,
    request: async (frame) => {
      sent.push(frame);
      if (opts.throwOnRequest) throw new Error("E_CONN_LOST: link dropped");
      const res = queue.shift();
      if (res === undefined) throw new Error(`unscripted request: ${frame.op}`);
      return { ...res, rid: frame.rid };
    },
    promptCode: async () => {
      promptCalls++;
      return opts.code;
    },
    showEnrollment: (i) => enrollments.push(i),
    showRecoveryCodes: (codes) => codesShown.push([...codes]),
    hasFeishuOwner: async () => {
      ownerChecks++;
      return opts.owner ?? true;
    },
    notify: (message, level) => notes.push({ message, level }),
  };
  return {
    deps,
    sent,
    notes,
    enrollments,
    codesShown,
    get promptCalls() {
      return promptCalls;
    },
    get ownerChecks() {
      return ownerChecks;
    },
  };
}

const ENROLL_SCRIPT = [
  okData({ kind: "totp_begin", otpauthUri: OTPAUTH_URI, secretB32: SECRET_B32 }),
  okData({ kind: "totp_confirm", recoveryCodes: RECOVERY_CODES }),
];

describe("/webhub 2fa — TUI-only gate (r1 #4, §5.8)", () => {
  const SECRET_SUBCOMMANDS = [
    "enroll",
    "enroll --replace",
    "feishu on",
    "recovery",
    "reset --confirm",
    "forget-ips",
    "repair --confirm",
  ];

  it("web-captured invocation (mode tui + webInvocation) ⇒ refused before any frame or render", async () => {
    for (const args of SECRET_SUBCOMMANDS) {
      const h = harness(ENROLL_SCRIPT, { code: "123456" });
      await runTwofaCommand(args, fakeCtx("tui", true), h.deps);
      expect(h.sent, args).toEqual([]);
      expect(h.promptCalls, args).toBe(0);
      expect(h.enrollments, args).toEqual([]);
      expect(h.codesShown, args).toEqual([]);
      expect(
        h.notes.some((n) => n.message.includes("仅允许在本地 TUI")),
        args,
      ).toBe(true);
    }
  });

  it("policy override cannot weaken the gate: a web-claimed ctx is refused regardless of policy", async () => {
    // command-policy.ts's `webhub: allow` only decides whether the web may INVOKE the command;
    // the captured ctx it produces is still `mode:"tui"` + `webInvocation:true` — and this gate
    // keys off exactly that marker, never the policy verdict.
    const h = harness(ENROLL_SCRIPT, { code: "123456" });
    await runTwofaCommand("enroll", fakeCtx("tui", true), h.deps);
    expect(h.sent).toEqual([]);
    expect(h.notes[0]?.level).toBe("warning");
  });

  it("non-TUI modes (rpc/print/json) ⇒ refused before any frame", async () => {
    for (const mode of ["rpc", "print", "json"] as const) {
      const h = harness(ENROLL_SCRIPT, { code: "123456" });
      await runTwofaCommand("enroll", fakeCtx(mode), h.deps);
      expect(h.sent, mode).toEqual([]);
      expect(
        h.notes.some((n) => n.message.includes("仅允许在本地 TUI")),
        mode,
      ).toBe(true);
    }
  });

  it("captured/refusal output is secret-free even though the script would have returned secrets", async () => {
    const h = harness(ENROLL_SCRIPT, { code: "123456" });
    await runTwofaCommand("enroll", fakeCtx("tui", true), h.deps);
    await runTwofaCommand("recovery", fakeCtx("tui", true), h.deps);
    const text = h.notes.map((n) => n.message).join("\n");
    expect(text).not.toContain(SECRET_B32);
    expect(text).not.toContain("otpauth://");
    for (const c of RECOVERY_CODES) expect(text).not.toContain(c);
  });

  it("status is web-safe: allowed from rpc mode and under webInvocation", async () => {
    const status = okData({
      kind: "status",
      state: "enrolled",
      totp: true,
      feishu: true,
      recoveryLeft: 7,
      knownIps: 2,
    });
    for (const web of [false, true]) {
      const h = harness([status]);
      await runTwofaCommand("status", fakeCtx(web ? "tui" : "rpc", web), h.deps);
      expect(h.sent.map((f) => f.op)).toEqual(["status"]);
      expect(h.notes.some((n) => n.message.includes("2fa=totp+feishu"))).toBe(true);
    }
  });
});

describe("/webhub 2fa — cap gate (old hub)", () => {
  it("no lan.2fa.v1 cap ⇒ 「hub 版本过旧，请 /webhub restart」, no frame sent", async () => {
    const h = harness([], { cap: false, code: "123456" });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.sent).toEqual([]);
    expect(h.notes.some((n) => n.message.includes("hub 版本过旧"))).toBe(true);
  });

  it("requestTfa short-circuits without calling request", async () => {
    const h = harness([], { cap: false });
    const res = await requestTfa(h.deps, { t: "tfa_req", rid: "r", op: "status" });
    expect(res).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
    expect(h.sent).toEqual([]);
  });
});

describe("/webhub 2fa enroll", () => {
  it("happy path: begin ⇒ QR+base32 shown once ⇒ masked code ⇒ confirm ⇒ codes shown exactly once", async () => {
    const h = harness(ENROLL_SCRIPT, { code: "123456" });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.sent.map((f) => f.op)).toEqual(["totp_begin", "totp_confirm"]);
    expect(h.sent[0]).not.toHaveProperty("replace");
    expect(h.sent[1]).toMatchObject({ op: "totp_confirm", code: "123456" });
    expect(h.enrollments).toEqual([{ otpauthUri: OTPAUTH_URI, secretB32: SECRET_B32 }]);
    expect(h.codesShown).toEqual([RECOVERY_CODES]);
    expect(h.notes.some((n) => n.message.includes("恢复码仅显示一次"))).toBe(true);
    // Q16 hint: enrollment never revokes existing sessions.
    expect(h.notes.some((n) => n.message.includes("已有登录会话保持有效"))).toBe(true);
  });

  it("--replace rides the totp_begin frame", async () => {
    const h = harness(ENROLL_SCRIPT, { code: "123456" });
    await runTwofaCommand("enroll --replace", fakeCtx(), h.deps);
    expect(h.sent[0]).toMatchObject({ op: "totp_begin", replace: true });
  });

  it("confirm answered with {kind:'ok'} (B contract: existing recovery set kept) ⇒ no codes rendered", async () => {
    const h = harness(
      [okData({ kind: "totp_begin", otpauthUri: OTPAUTH_URI, secretB32: SECRET_B32 }), okData({ kind: "ok" })],
      { code: "123456" },
    );
    await runTwofaCommand("enroll --replace", fakeCtx(), h.deps);
    expect(h.codesShown).toEqual([]);
    expect(h.notes.some((n) => n.message.includes("沿用既有恢复码"))).toBe(true);
    expect(h.notes.some((n) => n.message.includes("恢复码仅显示一次"))).toBe(false);
  });

  it("cancel at the code prompt ⇒ no confirm frame, no codes", async () => {
    const h = harness([ENROLL_SCRIPT[0]!], { code: undefined });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.sent.map((f) => f.op)).toEqual(["totp_begin"]);
    expect(h.codesShown).toEqual([]);
    expect(h.notes.some((n) => n.message.includes("已取消"))).toBe(true);
  });

  it("malformed code is rejected locally (§5.3): no confirm IPC, no attempt consumed", async () => {
    const h = harness([ENROLL_SCRIPT[0]!], { code: "12 34" });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.sent.map((f) => f.op)).toEqual(["totp_begin"]);
    expect(h.notes.some((n) => n.message.includes("6 位数字"))).toBe(true);
  });

  it("hub rejects the code ⇒ E_2FA_CODE message, no recovery codes rendered", async () => {
    const h = harness([ENROLL_SCRIPT[0]!, fail("E_2FA_CODE", "the code did not match")], { code: "000000" });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.codesShown).toEqual([]);
    expect(h.notes.some((n) => n.message.includes("验证码不正确"))).toBe(true);
  });

  it("transport failure mid-flow ⇒ warning, no crash, no codes", async () => {
    const h = harness([], { code: "123456", throwOnRequest: true });
    await runTwofaCommand("enroll", fakeCtx(), h.deps);
    expect(h.codesShown).toEqual([]);
    expect(h.notes.some((n) => n.level === "warning" && n.message.includes("E_CONN_LOST"))).toBe(true);
  });

  it("runTwofaEnrollPrompt: no-cap short-circuits before any request", async () => {
    const h = harness([], { cap: false });
    const outcome = await runTwofaEnrollPrompt(h.deps);
    expect(outcome).toEqual({ ok: false, reason: "no-cap" });
    expect(h.sent).toEqual([]);
  });
});

describe("/webhub 2fa feishu|recovery|reset|forget-ips|repair", () => {
  it("feishu on requires a bot owner, checked before any frame", async () => {
    const h = harness([], { owner: false });
    await runTwofaCommand("feishu on", fakeCtx(), h.deps);
    expect(h.ownerChecks).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.notes.some((n) => n.message.includes("飞书机器人未就绪"))).toBe(true);
  });

  it("feishu on first enrollment ⇒ recovery_regen variant rendered once; feishu off ⇒ plain ok", async () => {
    const on = harness([okData({ kind: "recovery_regen", recoveryCodes: RECOVERY_CODES })], { owner: true });
    await runTwofaCommand("feishu on", fakeCtx(), on.deps);
    expect(on.sent).toEqual([expect.objectContaining({ op: "feishu", on: true })]);
    expect(on.codesShown).toEqual([RECOVERY_CODES]);

    const off = harness([okData({ kind: "ok" })]);
    await runTwofaCommand("feishu off", fakeCtx(), off.deps);
    expect(off.sent).toEqual([expect.objectContaining({ op: "feishu", on: false })]);
    expect(off.ownerChecks).toBe(0);
    expect(off.notes.some((n) => n.message.includes("已关闭飞书审批"))).toBe(true);
  });

  it("recovery ⇒ codes rendered exactly once with the print-once warning", async () => {
    const h = harness([okData({ kind: "recovery_regen", recoveryCodes: RECOVERY_CODES })]);
    await runTwofaCommand("recovery", fakeCtx(), h.deps);
    expect(h.sent.map((f) => f.op)).toEqual(["recovery_regen"]);
    expect(h.codesShown).toEqual([RECOVERY_CODES]);
    expect(h.notes.some((n) => n.message.includes("仅显示一次"))).toBe(true);
    for (const c of RECOVERY_CODES) expect(c).toMatch(RECOVERY_CODE_RE);
  });

  it("reset/repair require --confirm; the flag becomes confirm:true on the frame", async () => {
    const bare = harness([]);
    await runTwofaCommand("reset", fakeCtx(), bare.deps);
    await runTwofaCommand("repair", fakeCtx(), bare.deps);
    expect(bare.sent).toEqual([]);
    expect(bare.notes.filter((n) => n.message.includes("--confirm"))).toHaveLength(2);

    const h = harness([okData({ kind: "ok" }), okData({ kind: "ok" })]);
    await runTwofaCommand("reset --confirm", fakeCtx(), h.deps);
    await runTwofaCommand("repair --confirm", fakeCtx(), h.deps);
    expect(h.sent[0]).toMatchObject({ op: "reset", confirm: true });
    expect(h.sent[1]).toMatchObject({ op: "repair", confirm: true });
    expect(h.notes.some((n) => n.message.includes("已重置"))).toBe(true);
    expect(h.notes.some((n) => n.message.includes("修复完成"))).toBe(true);
  });

  it("forget-ips sends the frame and explains the consequence", async () => {
    const h = harness([okData({ kind: "ok" })]);
    await runTwofaCommand("forget-ips", fakeCtx(), h.deps);
    expect(h.sent.map((f) => f.op)).toEqual(["forget_ips"]);
    expect(h.notes.some((n) => n.message.includes("视为新 IP"))).toBe(true);
  });

  it("hub-side refusal is rendered via the code map (never raw English at the user)", async () => {
    const h = harness([fail("E_2FA_NONE", "2FA is not enrolled")]);
    await runTwofaCommand("recovery", fakeCtx(), h.deps);
    expect(h.notes.some((n) => n.message.includes("未启用 2FA"))).toBe(true);
  });

  it("usage for unknown/missing subcommand; argument validation happens before the gate", async () => {
    const h = harness([]);
    await runTwofaCommand("", fakeCtx(), h.deps);
    await runTwofaCommand("bogus", fakeCtx(), h.deps);
    await runTwofaCommand("enroll --bogus", fakeCtx("rpc"), h.deps);
    expect(h.sent).toEqual([]);
    expect(h.notes.filter((n) => n.message.includes("用法")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("status fetch/format helpers (§6, P0 addendum item 2)", () => {
  it("fetchTfaStatus: ok ⇒ data; no-cap/transport/wrong-kind ⇒ undefined (never throws)", async () => {
    const status = {
      kind: "status" as const,
      state: "enrolled" as const,
      totp: true,
      feishu: false,
      recoveryLeft: 9,
      knownIps: 3,
    };
    const ok = harness([okData(status)]);
    expect(await fetchTfaStatus(ok.deps)).toEqual(status);

    const noCap = harness([], { cap: false });
    expect(await fetchTfaStatus(noCap.deps)).toBeUndefined();

    const broken = harness([], { throwOnRequest: true });
    expect(await fetchTfaStatus(broken.deps)).toBeUndefined();

    const wrongKind = harness([okData({ kind: "ok" })]);
    expect(await fetchTfaStatus(wrongKind.deps)).toBeUndefined();
  });

  it("formatTfaStatusLines renders off / factors / inconsistent / repairNeeded", () => {
    expect(
      formatTfaStatusLines({
        kind: "status",
        state: "none",
        totp: false,
        feishu: false,
        recoveryLeft: 0,
        knownIps: 0,
      })[0],
    ).toContain("2fa=off");
    expect(
      formatTfaStatusLines({
        kind: "status",
        state: "enrolled",
        totp: true,
        feishu: true,
        recoveryLeft: 7,
        knownIps: 2,
      })[0],
    ).toContain("2fa=totp+feishu（恢复码剩 7");
    const bad = formatTfaStatusLines({
      kind: "status",
      state: "inconsistent",
      totp: false,
      feishu: false,
      recoveryLeft: 0,
      knownIps: 0,
    });
    expect(bad.join("\n")).toContain("repair --confirm");
    const repair = formatTfaStatusLines({
      kind: "status",
      state: "enrolled",
      totp: true,
      feishu: false,
      recoveryLeft: 10,
      knownIps: 0,
      repairNeeded: "2fa-missing-row",
    });
    expect(repair.join("\n")).toContain("2fa-missing-row");
  });

  it("formatTfaError maps codes; unknown codes fall back to the hub message", () => {
    expect(formatTfaError("E_UNSUPPORTED", "hub 版本过旧，请 /webhub restart")).toContain("hub 版本过旧");
    expect(formatTfaError("E_2FA_CODE", "the code did not match")).toContain("验证码不正确");
    expect(formatTfaError("E_WHATEVER", "raw hub message")).toContain("raw hub message");
  });
});
