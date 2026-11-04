/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault } from "../secure/helpers.js";
import {
  BASELINE,
  HOST_KEY,
  emitAll,
  fakeCtx,
  fakePi,
  resetGlobals,
  sandbox,
  systemPromptFor,
} from "./helpers/schedule-activate.js";

/**
 * jev-reflex R0 (plan §4 步骤 1, PD8, A-tier): the reflex-OFF golden. Captured from `dev` BEFORE any
 * `src/reflex` code or hot-surface edit (`PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE=1`; refuses to overwrite
 * an existing file). It pins byte-for-byte what a real `activate()` looks like while the R layer is
 * off / forced off / inert, for four scenarios:
 *   default            — no `reflex` setting at all
 *   explicit-off       — `{reflex:{enabled:false}}`
 *   secure             — `{reflex:{enabled:true}}` inside a frozen secure-domain verdict (D8 forces it off)
 *   child              — HOST_KEY pre-claimed + `{reflex:{enabled:true}}` (child sessions stay inert, I6)
 * Per scenario: ordered tool / command tables, per-event handler counts, `registerMessageRenderer`
 * customTypes, the system prompt folded through `before_agent_start`, the outcome of a full `input`
 * chain run on `"后台还有几个 job"` (interactive) with every `sendMessage` / `appendEntry` it caused,
 * and the number of `subagent:reflex*` entries (must be 0).
 *
 * Never regenerate this to make a failing test pass: a diff means the reflex-off surface changed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "reflex-off-golden.json");

function normalize(value: unknown): unknown {
  const json = JSON.stringify(value)
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/([("[,])\/[^\n"')]*\/node(?=[",)\]])/g, "$1<node>");
  return JSON.parse(json) as unknown;
}

type Scenario = "default" | "explicit-off" | "secure" | "child";

const countReflex = (xs: Array<{ customType?: string }>): number =>
  xs.filter((x) => typeof x.customType === "string" && x.customType.startsWith("subagent:reflex")).length;

async function captureScenario(name: Scenario): Promise<Record<string, unknown>> {
  const sb = sandbox("pi-reflex-off-");
  resetGlobals();
  resetSecureDomainForTests();
  let vault: ReturnType<typeof makeFakeVault> | undefined;
  try {
    if (name === "default") sb.writeSettings({ ...BASELINE });
    else if (name === "explicit-off") sb.writeSettings({ ...BASELINE, reflex: { enabled: false } });
    else if (name === "child") {
      sb.writeSettings({ ...BASELINE, reflex: { enabled: true } });
      (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: 1 };
    } else {
      sb.writeSettings({ ...BASELINE, reflex: { enabled: true } });
      vault = makeFakeVault();
      const entry = { dir: vault.dir, mnt: vault.mnt };
      writeFileSync(
        vault.settingsPath,
        JSON.stringify({ ...BASELINE, reflex: { enabled: true }, secure: { vaults: { acme: entry } } }),
      );
      const frozen = freezeDomain(vault);
      expect(frozen.domain.kind).toBe("secure");
    }
    const h = fakePi();
    const renderers: string[] = [];
    const appended: Array<{ customType: string; data: unknown }> = [];
    (h.pi as any).registerMessageRenderer = (customType: string) => void renderers.push(customType);
    (h.pi as any).appendEntry = (customType: string, data: unknown) => void appended.push({ customType, data });
    activate(h.pi);
    const c = fakeCtx(sb.home);
    const emitted = { tools: [...h.toolOrder], commands: [...h.commandOrder] };
    await emitAll(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
    const prompt = await systemPromptFor(h, c.ctx);
    const inputResults = await emitAll(
      h,
      "input",
      { type: "input", text: "后台还有几个 job", source: "interactive" },
      c.ctx,
    );
    const inputActions = inputResults.map((r) =>
      r instanceof Error ? "<throw>" : r === undefined ? "<undefined>" : r,
    );
    await emitAll(h, "agent_settled", { aborted: false }, c.ctx);
    await emitAll(h, "session_shutdown", { type: "session_shutdown", reason: "quit" }, c.ctx);
    return {
      tools: emitted.tools,
      commands: emitted.commands,
      handlerCounts: Object.fromEntries([...h.handlers].map(([k, v]) => [k, v.length]).sort()),
      renderers,
      systemPrompt: prompt,
      inputActions,
      sendMessage: h.sent.map((s) => ({ customType: s.message?.customType, options: s.options })),
      appendEntry: appended.map((a) => a.customType),
      reflexEntryCount: countReflex(h.sent.map((s) => s.message ?? {})) + countReflex(appended),
    };
  } finally {
    resetGlobals();
    resetSecureDomainForTests();
    vault?.cleanup();
    sb.cleanup();
  }
}

async function capture(): Promise<Record<string, unknown>> {
  const scenarios: Record<string, unknown> = {};
  for (const name of ["default", "explicit-off", "secure", "child"] as const)
    scenarios[name] = await captureScenario(name);
  return normalize({
    note: "reflex-off golden captured at jev-reflex R0 on dev before any src/reflex change. Never regenerate to fix a diff.",
    scenarios,
  }) as Record<string, unknown>;
}

describe("reflex off golden (jev-reflex plan §4 R0)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("is deterministic and carries no reflex surface in any off scenario", async () => {
    const first = (await capture()) as { scenarios: Record<string, any> };
    expect(await capture()).toEqual(first);
    for (const [name, s] of Object.entries(first.scenarios)) {
      expect(s.reflexEntryCount, name).toBe(0);
      expect(s.commands, name).not.toContain("reflex");
      expect(s.renderers, name).not.toContain("subagent:reflex");
      expect(s.systemPrompt, name).not.toMatch(/reflex/i);
    }
  });
});
