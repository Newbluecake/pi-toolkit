// feishu-bot plan v2 §9/§10/§R2-e (F9): the `/webhub feishu …` TUI-only admin surface — routing,
// TUI guard, confirms, wiring of status/allow/deny/repair/reset/setup and the completions.

import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand, formatFeishuSettingsWarningLine } from "../../src/commands/webhub.js";
import type { FeishuAdminPort, FeishuNotifyCoexistence } from "../../src/web-hub/agent/feishu-admin.js";
import type { FsbResFrame } from "../../src/web-hub/protocol/feishu.js";

interface FakeCtx {
  ctx: ExtensionCommandContext;
  notes: Array<{ message: string; level: string }>;
  confirms: Array<{ title: string; message: string }>;
  setConfirm(answer: boolean): void;
  widgetHistory: Array<[string, string[] | undefined]>;
}

function fakeCtx(mode = "tui", confirmAnswer = true): FakeCtx {
  const notes: FakeCtx["notes"] = [];
  const confirms: FakeCtx["confirms"] = [];
  const widgetHistory: FakeCtx["widgetHistory"] = [];
  let answer = confirmAnswer;
  const ctx = {
    mode,
    ui: {
      notify: (message: string, level: string) => notes.push({ message, level }),
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return answer;
      },
      setWidget: (key: string, content: string[] | undefined) => {
        widgetHistory.push([key, content]);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes, confirms, widgetHistory, setConfirm: (v: boolean) => (answer = v) };
}

function fakePort(
  respond: (frame: Record<string, unknown>) => FsbResFrame,
  over: Partial<FeishuAdminPort> = {},
): { port: FeishuAdminPort; sent: unknown[] } {
  const sent: unknown[] = [];
  const port: FeishuAdminPort = {
    live: true,
    state: "live",
    caps: ["fsb.v1"],
    request: async (frame) => {
      sent.push(frame);
      return respond(frame as unknown as Record<string, unknown>);
    },
    ...over,
  };
  return { port, sent };
}

const NO_COEXIST: FeishuNotifyCoexistence = { configured: false, watchDefault: false };

const INFO_DATA = {
  status: "open",
  brand: "feishu",
  gen: 1,
  uptimeMs: 1_000,
  reconnects: 0,
  counters: { in: 1, dup: 0, dropped: {} },
  outbox: { ok: 0, failed: 0 },
  bindings: { total: 0, offline: 0, ambiguous: 0 },
  caps: { cards: "ok", reactions: "ok", files: "ok", cardCallback: "ok" },
  keepalive: true,
  owner: "ou_…9f3c",
  allow: ["ou_…9f3c"],
};

function fakeControl(): never {
  return {
    status: () => ({ state: "live", attached: true }),
    url: () => ({ url: "http://127.0.0.1:1/#t=x" }),
    lan: {
      statusLines: () => [],
      info: async () => ({ ok: false, reason: "unavailable" }),
      unlock: async () => ({ ok: false, reason: "unavailable" }),
      changePasswordInteractive: async () => ({ ok: false, reason: "no-cap" }),
      restart: async () => ({ kind: "manual", message: "x" }),
    },
    ui: { statusLines: () => [] },
    privacy: { statusLines: () => [] },
    admin: {
      stop: async () => ({ kind: "stopped" }),
      start: async () => ({ kind: "started" }),
      clearStopMarker: async () => ({ kind: "cleared" }),
      rotateToken: async () => ({ kind: "offline" }),
    },
    internalExec: async () => ({ ok: true }),
  } as never;
}

async function run(
  args: string,
  opts: {
    port?: FeishuAdminPort | undefined;
    mode?: string;
    confirm?: boolean;
    warnings?: string[];
    coexistence?: FeishuNotifyCoexistence;
    now?: () => number;
  } = {},
): Promise<{ notes: Array<{ message: string; level: string }>; c: FakeCtx }> {
  const c = fakeCtx(opts.mode ?? "tui", opts.confirm ?? true);
  const cmd = createWebHubCommand({
    control: () => fakeControl(),
    feishuPort: () => opts.port,
    ...(opts.warnings !== undefined ? { feishuSettingsWarnings: () => opts.warnings as never } : {}),
    ...(opts.coexistence !== undefined ? { feishuCoexistence: () => opts.coexistence } : {}),
    feishuSleep: async () => {},
    now: opts.now ?? (() => 0),
  });
  await cmd.handler(args, c.ctx);
  return { notes: c.notes, c };
}

describe("/webhub feishu routing", () => {
  const live = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true, data: INFO_DATA }));

  it("no op / unknown op ⇒ feishu usage (hub untouched)", async () => {
    for (const args of ["feishu", "feishu bogus"]) {
      const { notes } = await run(args, { port: live.port });
      expect(notes, args).toHaveLength(1);
      expect(notes[0]!.level).toBe("warning");
      expect(notes[0]!.message).toContain("/webhub feishu <");
      expect(notes[0]!.message).toContain("仅 TUI");
    }
    expect(live.sent).toHaveLength(0);
  });

  it("non-TUI modes are refused (§R2-e: local TUI admin only)", async () => {
    for (const mode of ["rpc", "print", "json"]) {
      const { notes } = await run("feishu status", { port: live.port, mode });
      expect(notes, mode).toHaveLength(1);
      expect(notes[0]!.message).toContain("仅支持在 TUI");
    }
    expect(live.sent).toHaveLength(0);
  });

  it("no port (web-hub off) ⇒ the web-hub guidance warning", async () => {
    const { notes } = await run("feishu status", { port: undefined });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("web-hub 未启用");
  });

  it("a hub without fsb.v1 says so clearly", async () => {
    const noCap = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true }), { caps: ["cmd.v1"] });
    const { notes } = await run("feishu status", { port: noCap.port });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("尚不支持飞书机器人");
    expect(notes[0]!.message).toContain("fsb.v1");
    expect(noCap.sent).toHaveLength(0);
  });

  it("ops reject unexpected args", async () => {
    for (const args of ["feishu status extra", "feishu cancel extra", "feishu repair extra", "feishu reset extra"]) {
      const { notes } = await run(args, { port: live.port });
      expect(notes, args).toHaveLength(1);
      expect(notes[0]!.message).toContain("不接受任何参数");
    }
    expect(live.sent).toHaveLength(0);
  });
});

describe("/webhub feishu status", () => {
  it("renders the §10 lines plus keepalive prose; no settings/coexistence noise by default", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true, data: INFO_DATA }));
    const { notes } = await run("feishu status", {
      port: p.port,
      warnings: [],
      coexistence: NO_COEXIST,
    });
    const messages = notes.map((n) => n.message);
    expect(messages[0]).toBe("feishu: status=open brand=feishu gen=1 uptime=1s reconnects=0");
    expect(messages[1]).toBe("counters: in=1 dup=0");
    expect(messages[2]).toBe("outbox: ok=0 failed=0");
    expect(messages[3]).toBe("bindings: total=0 offline=0 amb=0");
    expect(messages[4]).toBe("caps: cards=✓ reactions=✓ files=✓ cb=✓");
    expect(messages[5]).toBe("keepalive=on");
    expect(messages[6]).toBe("owner=ou_…9f3c allow=1: ou_…9f3c");
    expect(messages.at(-1)).toContain("空闲");
    expect(p.sent).toEqual([{ t: "fsb_req", rid: expect.any(String), op: "info" }]);
    expect(notes.every((n) => n.level === "info")).toBe(true);
  });

  it("degraded status warns, and settings + coexistence warnings ride along", async () => {
    const p = fakePort(() => ({
      t: "fsb_res",
      rid: "r",
      ok: true,
      data: { ...INFO_DATA, status: "degraded", degraded: ["state-corrupt"] },
    }));
    const { notes } = await run("feishu status", {
      port: p.port,
      warnings: ["debounce-clamped", "notify-invalid"],
      coexistence: { configured: true, watchDefault: true },
    });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("degraded(state-corrupt)");
    expect(notes.some((n) => n.message.includes("/webhub feishu repair"))).toBe(true);
    expect(notes.some((n) => n.message.includes("feishuBot 设置告警"))).toBe(true);
    expect(notes.some((n) => n.message.includes("feishu-notify"))).toBe(true);
    expect(notes.some((n) => n.message.includes("watchDefault:true"))).toBe(true);
  });

  it("a refused info maps the code; a transport failure maps its reason", async () => {
    const refused = fakePort(() => ({ t: "fsb_res", rid: "r", ok: false, code: "E_FSB_STATE", message: "corrupt" }));
    const r1 = await run("feishu status", { port: refused.port, warnings: [], coexistence: NO_COEXIST });
    expect(r1.notes).toHaveLength(1);
    expect(r1.notes[0]!.message).toContain("corrupt");

    const dead = fakePort(() => {
      throw new Error("E_CONN_LOST: link torn down");
    });
    const r2 = await run("feishu status", { port: dead.port, warnings: [], coexistence: NO_COEXIST });
    expect(r2.notes[0]!.message).toContain("中断");
  });

  it("formatFeishuSettingsWarningLine renders every warning code and stays silent when clean", () => {
    expect(formatFeishuSettingsWarningLine([])).toBeUndefined();
    const line = formatFeishuSettingsWarningLine(["block-invalid", "stale-clamped"]);
    expect(line).toContain("feishuBot 块不是对象");
    expect(line).toContain("30–3600");
    expect(line).toContain("/reload");
  });
});

describe("/webhub feishu allow|deny", () => {
  it("validates the open_id client-side before anything is sent", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true, data: { changed: true, count: 2 } }));
    for (const args of ["feishu allow", "feishu deny", "feishu allow not-an-id", "feishu allow ou_x ou_y"]) {
      const { notes } = await run(args, { port: p.port });
      expect(notes, args).toHaveLength(1);
      expect(notes[0]!.message).toContain("<open_id>");
    }
    expect(p.sent).toHaveLength(0);
  });

  it("sends the frame with openId and renders the result", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true, data: { changed: true, count: 2 } }));
    const { notes } = await run("feishu allow ou_ABCdef1234-_xy", { port: p.port });
    expect(p.sent).toEqual([{ t: "fsb_req", rid: expect.any(String), op: "allow", openId: "ou_ABCdef1234-_xy" }]);
    expect(notes[0]!.message).toBe("allow: changed allow-list=2");
    const d = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true, data: { changed: false, count: 1 } }));
    const r2 = await run("feishu deny ou_ABCdef1234-_xy", { port: d.port });
    expect(r2.notes[0]!.message).toBe("deny: unchanged allow-list=1");
  });

  it("a cap refusal surfaces the allow-list cap hint", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: false, code: "E_FSB_CAP", message: "allow-list full" }));
    const { notes } = await run("feishu allow ou_ABCdef1234-_xy", { port: p.port });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("allow-list full");
  });
});

describe("/webhub feishu repair|reset (TUI confirm required)", () => {
  const ok = () => ({ t: "fsb_res", rid: "r", ok: true });

  it("declining the confirm sends nothing", async () => {
    const p = fakePort(ok);
    const { notes, c } = await run("feishu reset", { port: p.port, confirm: false });
    expect(c.confirms).toHaveLength(1);
    expect(c.confirms[0]!.title).toBe("feishu reset");
    expect(p.sent).toHaveLength(0);
    expect(notes[0]!.message).toContain("已取消");
  });

  it("confirming sends confirm:true and renders the outcome", async () => {
    for (const [op, needle] of [
      ["repair", "修复完成"],
      ["reset", "已重置"],
    ] as const) {
      const p = fakePort(ok);
      const { notes } = await run(`feishu ${op}`, { port: p.port, confirm: true });
      expect(p.sent).toEqual([{ t: "fsb_req", rid: expect.any(String), op, confirm: true }]);
      expect(notes.at(-1)!.message).toContain(needle);
    }
  });

  it("a confirm-required refusal (hub did not see confirm) is a warning", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: false, code: "E_FSB_CONFIRM_REQUIRED", message: "" }));
    const { notes } = await run("feishu repair", { port: p.port, confirm: true });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("--replace");
  });
});

describe("/webhub feishu setup", () => {
  const pendingView = {
    phase: "pending",
    qrUrl: "https://open.feishu.cn/page/launcher?user_code=XYZ",
    expiresAt: 60_000,
  };

  function setupPort(phases: string[]): { port: FeishuAdminPort; sent: unknown[] } {
    let i = 0;
    return fakePort(() => {
      const phase = phases[Math.min(i, phases.length - 1)]!;
      i += 1;
      return phase === "pending0"
        ? { t: "fsb_res", rid: "r", ok: true, data: pendingView }
        : { t: "fsb_res", rid: "r", ok: true, data: { phase } };
    });
  }

  it("plain setup: no confirm dialog, begin without replace, QR widget shown then cleared", async () => {
    const p = setupPort(["pending0", "done"]);
    const { notes, c } = await run("feishu setup", { port: p.port });
    expect(c.confirms).toHaveLength(0);
    expect(p.sent[0]).toEqual({ t: "fsb_req", rid: expect.any(String), op: "setup_begin" });
    // a real rendered QR from src/commands/qr-render.ts rides the widget, then it is cleared
    const shown = c.widgetHistory.filter(([k]) => k === "webhub-feishu-qr");
    expect(shown.length).toBeGreaterThanOrEqual(2);
    const qr = shown[0]![1];
    expect(qr).toBeDefined();
    expect(qr!.length).toBeGreaterThan(10);
    expect(qr!.every((l) => /^[█▀▄ ]+$/.test(l))).toBe(true);
    expect(shown.at(-1)![1]).toBeUndefined();
    expect(notes.some((n) => n.message === pendingView.qrUrl)).toBe(true);
    expect(notes.at(-1)!.message).toContain("配置完成");
  });

  it("the widget is cleared after the flow ends (clearQr → setWidget undefined)", async () => {
    const p = setupPort(["pending0", "expired"]);
    const { c } = await run("feishu setup", { port: p.port });
    const shown = c.widgetHistory.filter(([k]) => k === "webhub-feishu-qr");
    expect(shown[0]![1]).toBeDefined();
    expect(shown.at(-1)![1]).toBeUndefined();
  });

  it("--replace asks the TUI confirm and only then sends replace+confirm", async () => {
    const p = setupPort(["done"]);
    const declined = await run("feishu setup --replace", { port: p.port, confirm: false });
    expect(declined.c.confirms[0]!.title).toBe("feishu setup --replace");
    expect(declined.c.confirms[0]!.message).toContain("替换");
    expect(p.sent).toHaveLength(0);
    const ok = await run("feishu setup --replace", { port: p.port, confirm: true });
    expect(p.sent[0]).toEqual({
      t: "fsb_req",
      rid: expect.any(String),
      op: "setup_begin",
      replace: true,
      confirm: true,
    });
    expect(ok.notes.at(-1)!.message).toContain("配置完成");
  });

  it("an unknown flag is rejected before anything is sent", async () => {
    const p = setupPort(["done"]);
    const { notes } = await run("feishu setup --bogus", { port: p.port });
    expect(notes[0]!.message).toContain("/webhub feishu setup [--replace]");
    expect(p.sent).toHaveLength(0);
  });
});

describe("/webhub feishu cancel", () => {
  it("sends setup_cancel and reports the fenced generation", async () => {
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true }));
    const { notes } = await run("feishu cancel", { port: p.port });
    expect(p.sent).toEqual([{ t: "fsb_req", rid: expect.any(String), op: "setup_cancel" }]);
    expect(notes[0]!.message).toContain("栅栏");
  });
});

describe("completions", () => {
  const cmd = () => createWebHubCommand({ control: () => undefined });

  it("lists feishu among the top-level subcommands", () => {
    const items = cmd().getArgumentCompletions!("")!;
    expect(items.map((i) => i.value).sort()).toEqual([
      "feishu",
      "open",
      "passwd",
      "restart",
      "start",
      "status",
      "stop",
      "token",
      "unlock",
    ]);
    const feishu = items.find((i) => i.value === "feishu")!;
    expect(feishu.description).toContain("仅 TUI");
  });

  it("completes the feishu op vocabulary and setup's --replace", () => {
    expect(cmd().getArgumentCompletions!("feishu")!.map((i) => i.value)).toEqual(["feishu"]);
    expect(
      cmd().getArgumentCompletions!("feishu ")!
        .map((i) => i.value)
        .sort(),
    ).toEqual(["allow", "cancel", "deny", "repair", "reset", "setup", "status"].sort());
    expect(
      cmd().getArgumentCompletions!("feishu s")!
        .map((i) => i.value)
        .sort(),
    ).toEqual(["setup", "status"]);
    expect(cmd().getArgumentCompletions!("feishu setup ")!.map((i) => i.value)).toEqual(["--replace"]);
    expect(cmd().getArgumentCompletions!("feishu setup --")!.map((i) => i.value)).toEqual(["--replace"]);
    expect(cmd().getArgumentCompletions!("feishu allow ou_")!).toEqual([]);
  });

  it("never throws on odd input", () => {
    expect(cmd().getArgumentCompletions!(undefined as unknown as string)).toEqual([]);
  });
});

describe("handler exceptions never reject (zero-hang discipline)", () => {
  it("a throwing ui.confirm counts as declined (fail closed)", async () => {
    const c = fakeCtx("tui", true);
    const p = fakePort(() => ({ t: "fsb_res", rid: "r", ok: true }));
    const cmd = createWebHubCommand({
      control: () => fakeControl(),
      feishuPort: () => p.port,
    });
    const originalConfirm = (c.ctx.ui as { confirm: (t: string, m: string) => Promise<boolean> }).confirm;
    (c.ctx.ui as unknown as { confirm: (t: string, m: string) => Promise<boolean> }).confirm = () =>
      Promise.reject(new Error("ui gone"));
    await expect(cmd.handler("feishu reset", c.ctx)).resolves.toBeUndefined();
    (c.ctx.ui as unknown as { confirm: (t: string, m: string) => Promise<boolean> }).confirm = originalConfirm;
    expect(p.sent).toHaveLength(0);
    expect(c.notes.some((n) => n.message.includes("已取消"))).toBe(true);
  });
});
