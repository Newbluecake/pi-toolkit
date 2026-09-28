#!/usr/bin/env -S npx tsx
/**
 * P2 control-plane assertion module for the visual harness (control-plan.md v2.1 §9.3, §12.3 —
 * **C6 framework**; `visual.ts` glob-loads it automatically; C5 takes ownership of this file and
 * fills the assertions' teeth as its components land).
 *
 * Two surfaces:
 *
 * 1. The `check` module — §9.3's check inventory (dock never covers the last transcript
 *    message, Composer key map, StopButton two-step, AskUserForm structure, ControlNotice
 *    persistence, TopBar chip, hub-state banner, axe on the control scenarios). The framework's
 *    real deliverable at C6 is the **selector + scenario contract** below: C5's components
 *    (`components/control/**`, `components/dialog/**`, `shell/HubStateBanner.vue`) must render
 *    DOM matching `CONTROL_SELECTORS`, on scenarios matching `CONTROL_SCENARIOS` (backed by
 *    `tests/fixtures/web-hub-ui/{control,ask-user,commands,hub-states}.json`). Until that DOM
 *    exists every check here is a *silent no-op* (returns `[]`) — same not-applicable
 *    philosophy as `checks-shell.ts`'s optional checks, so a pre-C5 harness run stays green
 *    without a single stubbed pass. CSP/console hygiene is deliberately NOT re-asserted here:
 *    `checks-common.ts` already covers it for every cell.
 *
 * 2. `--probe` sub-mode (§9.3: "K16 三内核 Origin 回显、K18 randomUUID 不可用检查并入
 *    checks-control.ts 的 --probe 子模式"): starts its own dev-hub (`control` scenario), drives
 *    a real headless browser through a login + a same-origin `POST /api/cmd`, and reads the
 *    request's `Origin`/`Sec-Fetch-Site` headers back from dev-hub's recorded
 *    `controlRequests()` (K16), plus the page's `crypto.randomUUID`/`getRandomValues`
 *    availability (K18) — asserted on BOTH the loopback origin (secure context: both present)
 *    and a real LAN plain-HTTP origin (`http://<lan-ip>`, not a secure context: `randomUUID`
 *    absent, `getRandomValues` present). Only Chromium is resolvable offline on this machine
 *    (`lib/playwright.ts` pin) — K16's Firefox/WebKit rows remain W5 真机 items, and the probe
 *    says so in its output.
 *    Exit codes: 0 = all probes ok, 1 = a probe assertion failed, 2 = browser unavailable or
 *    usage error.
 *
 * scripts/** is outside the tsc project; self-check with:
 *   npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 \
 *     --skipLibCheck scripts/web-hub/visual/checks-control.ts
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import type { CheckContext, CheckModule, CheckOutcome, ExtPage } from "../visual.js";
import { formatAxeViolations, type AxeViolationLike } from "./checks-e2e.js";
import { createDevHub, type DevHubHandle } from "../dev-hub.js";
import { loadPlaywright, type PwBrowser, type PwChromium } from "../lib/playwright.js";

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

// ---------------------------------------------------------------------------
// selector + scenario contract (the framework C5 builds against)
// ---------------------------------------------------------------------------

/** DOM contract for C5's control/dialog components. A check referencing a selector whose
 * element isn't mounted returns `[]` (not-applicable), so renaming one of these is the ONLY
 * way to silently lose coverage — component tests (`tests/web-hub/ui/*control*` et al., C5)
 * should assert the same selectors from this module rather than duplicating literals. */
export const CONTROL_SELECTORS = {
  dock: ".dock",
  transcriptItem: ".tx-item",
  composer: ".composer textarea",
  composerSend: ".composer [data-send]",
  deliverSwitch: ".deliver-switch",
  stopButton: ".stop-btn",
  queueList: ".queue-list",
  controlNotice: ".control-notice",
  topbarControlChip: ".topbar .control-chip",
  topbarReadonlyChip: ".topbar .readonly-chip",
  askUserForm: ".ask-user-form",
  askUserTab: ".ask-user-form [data-question-tab]",
  askUserOther: ".ask-user-form [data-other]",
  askUserSubmit: ".ask-user-form [data-submit]",
  hubStateBanner: ".hub-state-banner",
  commandPalette: ".command-palette",
  commandResult: ".command-result",
} as const;

/** Scenarios backed by C6's fixtures (`tests/fixtures/web-hub-ui/<name>.json`). The visual
 * harness's scenario list lives in P2's frozen `visual.ts` — until the frozen-surface change
 * that registers these lands (see the C6 report's 冻结面变更提议), this module only ever runs
 * its checks when a future harness revision routes one of these names. */
export const CONTROL_SCENARIOS = ["control", "ask-user", "commands", "hub-states"] as const;
export type ControlScenario = (typeof CONTROL_SCENARIOS)[number];

export function isControlScenario(scenario: string): scenario is ControlScenario {
  return (CONTROL_SCENARIOS as readonly string[]).includes(scenario);
}

/** `/api/cmd` + `/api/dialog` are POST-only endpoints, so a URL match is a control write. */
export function isControlApiPath(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p === "/api/cmd" || p === "/api/dialog";
  } catch {
    return false;
  }
}

/** Mutating keyboard checks run once per scenario at one representative split-view cell (same
 * cost discipline as checks-e2e.ts): 1024px, mouse pointer, light theme. */
export function isControlActionCell(
  scenario: string,
  width: number,
  hasTouch: boolean,
  theme: "light" | "dark",
): boolean {
  return isControlScenario(scenario) && width === 1024 && !hasTouch && theme === "light";
}

/** axe on the control scenarios (§9.3 "axe 0 违规"): one narrow + one split width, BOTH themes
 * (color-contrast is theme-dependent), mirroring checks-e2e.ts's axe gating. */
export function isControlAxeCell(scenario: string, width: number, hasTouch: boolean): boolean {
  return isControlScenario(scenario) && (width === 375 || (width === 1024 && !hasTouch));
}

function countControlPosts(ctx: CheckContext): number {
  return ctx.requests.filter((r) => isControlApiPath(r.url)).length;
}

/** ExtPage lacks `keyboard` (same cast-only pattern checks-e2e.ts documents). */
interface ControlPage extends ExtPage {
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
}

function asControlPage(ctx: CheckContext): ControlPage {
  return ctx.page as unknown as ControlPage;
}

// ---------------------------------------------------------------------------
// checks (all DOM-gated no-ops until C5's components land)
// ---------------------------------------------------------------------------

/** §9.3 "dock 不遮挡最后一条消息": the dock is in the document flow (checks-shell already
 * asserts it's never fixed/sticky) — this asserts the stronger visible property: its top edge
 * starts at or below the last transcript item's bottom edge. */
async function checkDockDoesNotCoverLastMessage(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "control" && ctx.scenario !== "ask-user") return [];
  const info = await ctx.page.evaluate((sel) => {
    const dock = document.querySelector(sel.dock);
    const items = document.querySelectorAll(sel.transcriptItem);
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    if (!dock || !last) return null;
    const d = dock.getBoundingClientRect();
    const t = last.getBoundingClientRect();
    return { dockTop: d.top, lastBottom: t.bottom };
  }, CONTROL_SELECTORS);
  if (info === null) return [];
  return [
    outcome(
      "control-dock-not-covering-last-message",
      info.dockTop >= info.lastBottom - 1,
      `dockTop=${info.dockTop} lastItemBottom=${info.lastBottom}`,
    ),
  ];
}

/** §9.3 "ControlNotice 不可关闭": the persistent risk notice may COLLAPSE (details/summary)
 * but must have no dismiss/close control. */
async function checkControlNoticePersistent(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlScenario(ctx.scenario)) return [];
  const info = await ctx.page.evaluate((sel) => {
    const notice = document.querySelector(sel.controlNotice);
    if (!notice) return null;
    const buttons = [...notice.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent ?? "",
    );
    return { buttons };
  }, CONTROL_SELECTORS);
  if (info === null) return [];
  const closer = info.buttons.find((b) => /close|dismiss|关闭/i.test(b));
  return [
    outcome(
      "control-notice-no-close-button",
      closer === undefined,
      closer === undefined ? undefined : `found close-like control "${closer}"`,
    ),
  ];
}

/** §9.3 "StopButton 两步": first click only ARMS the button (no /api/cmd POST), second click
 * sends the abort. */
async function checkStopButtonTwoStep(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlActionCell(ctx.scenario, ctx.width, ctx.hasTouch, ctx.theme)) return [];
  const page = asControlPage(ctx);
  const present = await page.evaluate((sel) => document.querySelector(sel.stopButton) !== null, CONTROL_SELECTORS);
  if (!present) return [];
  const before = countControlPosts(ctx);
  await page.click(CONTROL_SELECTORS.stopButton);
  await page.waitForTimeout(300);
  const afterFirst = countControlPosts(ctx);
  const armed = await page.evaluate((sel) => {
    const btn = document.querySelector(sel.stopButton);
    if (!btn) return false;
    return btn.getAttribute("data-armed") === "true" || /confirm/i.test(btn.textContent ?? "");
  }, CONTROL_SELECTORS);
  await page.click(CONTROL_SELECTORS.stopButton);
  await page.waitForTimeout(500);
  const afterSecond = countControlPosts(ctx);
  return [
    outcome(
      "control-stop-first-click-arms-only",
      afterFirst === before && armed,
      `posts ${before}→${afterFirst}, armed=${armed}`,
    ),
    outcome("control-stop-second-click-sends", afterSecond === afterFirst + 1, `posts ${afterFirst}→${afterSecond}`),
  ];
}

/** §9.3 "Composer 键位": Enter sends (desktop), Shift+Enter inserts a newline, an IME
 * composition session suppresses the send, and Alt+Enter on the BUSY routed agent (control.json's
 * agent-alpha is busy) queues as followUp — asserted on the wire via the POST body's `deliver`
 * field (D4). `ctx.requests` records URLs only, so the Alt+Enter assertion attaches its own
 * request listener capturing `postData` for the two control write endpoints. */
async function checkComposerKeys(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlActionCell(ctx.scenario, ctx.width, ctx.hasTouch, ctx.theme)) return [];
  const page = asControlPage(ctx);
  const present = await page.evaluate((sel) => document.querySelector(sel.composer) !== null, CONTROL_SELECTORS);
  if (!present) return [];
  const results: CheckOutcome[] = [];
  const controlPostBodies: Array<string | null> = [];
  page.on("request", (arg: unknown) => {
    const req = arg as { url(): string; postData(): string | null };
    if (isControlApiPath(req.url())) controlPostBodies.push(req.postData());
  });

  // Enter sends.
  let before = countControlPosts(ctx);
  await page.click(CONTROL_SELECTORS.composer);
  await page.keyboard.type("visual probe message");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  results.push(
    outcome(
      "control-composer-enter-sends",
      countControlPosts(ctx) === before + 1,
      `posts ${before}→${countControlPosts(ctx)}`,
    ),
  );

  // Shift+Enter is a newline, never a send.
  before = countControlPosts(ctx);
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await page.waitForTimeout(300);
  const value = await page.evaluate(
    (sel) => (document.querySelector(sel.composer) as HTMLTextAreaElement | null)?.value ?? "",
    CONTROL_SELECTORS,
  );
  results.push(
    outcome(
      "control-composer-shift-enter-newline",
      countControlPosts(ctx) === before && value.includes("\n"),
      `posts ${before}→${countControlPosts(ctx)}, value=${JSON.stringify(value)}`,
    ),
  );

  // IME composition: Enter during an active composition session must not send.
  before = countControlPosts(ctx);
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel.composer);
    ta?.dispatchEvent(new CompositionEvent("compositionstart", { data: "ni" }));
  }, CONTROL_SELECTORS);
  await page.keyboard.press("Enter");
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel.composer);
    ta?.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }));
  }, CONTROL_SELECTORS);
  await page.waitForTimeout(300);
  results.push(
    outcome(
      "control-composer-ime-no-send",
      countControlPosts(ctx) === before,
      `posts ${before}→${countControlPosts(ctx)}`,
    ),
  );

  // Alt+Enter (busy agent ⇒ followUp, D4): must POST /api/cmd once with body
  // `deliver:"followUp"` — the wire assertion is what separates this from a plain steer.
  before = countControlPosts(ctx);
  const bodiesBefore = controlPostBodies.length;
  await page.click(CONTROL_SELECTORS.composer);
  await page.keyboard.type(" alt-enter probe");
  await page.keyboard.press("Alt+Enter");
  await page.waitForTimeout(500);
  const newBodies = controlPostBodies.slice(bodiesBefore);
  const followUpSent = newBodies.some((b) => {
    if (b === null) return false;
    try {
      const parsed: unknown = JSON.parse(b);
      if (typeof parsed !== "object" || parsed === null) return false;
      const rec = parsed as Record<string, unknown>;
      return rec["op"] === "prompt" && rec["deliver"] === "followUp";
    } catch {
      return false;
    }
  });
  results.push(
    outcome(
      "control-composer-alt-enter-followup",
      countControlPosts(ctx) === before + 1 && followUpSent,
      `posts ${before}→${countControlPosts(ctx)}, bodies=[${newBodies
        .map((b) => (b === null ? "∅" : b.slice(0, 160)))
        .join(" | ")}]`,
    ),
  );
  return results;
}

/** §9.3 "AskUserForm 多题 tab 与 Other": multi-question dialogs render one tab per question
 * plus a free-text Other affordance, and Submit stays disabled until every question has an
 * answer. Structural assertions only — the submit race itself is covered by dev-hub's
 * `/api/dialog` (409 on a lost race) and dev-hub.test.ts. */
async function checkAskUserFormStructure(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "ask-user") return [];
  const readForm = (sel: typeof CONTROL_SELECTORS) => {
    const form = document.querySelector(sel.askUserForm);
    if (!form) return null;
    return {
      tabs: form.querySelectorAll(sel.askUserTab).length,
      questions: form.querySelectorAll("fieldset").length,
      hasOther: form.querySelector(sel.askUserOther) !== null,
      submitDisabled: (form.querySelector(sel.askUserSubmit) as HTMLButtonElement | null)?.disabled ?? null,
    };
  };
  // Phase 1: the scenario route (agent-alpha) is a SINGLE-question dialog — no tabs by design
  // (§7.4: tabs only for multi-question), but the Other affordance and submit gating apply.
  const single = await ctx.page.evaluate(readForm, CONTROL_SELECTORS);
  if (single === null) return [];
  const outcomes: CheckOutcome[] = [
    outcome("control-ask-user-single-no-tabs", single.tabs === 0 && single.questions === 1, JSON.stringify(single)),
    outcome("control-ask-user-other-input", single.hasOther, "no [data-other] input"),
    outcome(
      "control-ask-user-submit-gated",
      single.submitDisabled === true,
      `submitDisabled=${String(single.submitDisabled)} (unanswered form must not be submittable)`,
    ),
  ];
  // Phase 2: agent-beta carries the MULTI-question dialog — one header tab per question, all
  // questions mounted (v-show), Submit still gated until every question is answered.
  await ctx.page.evaluate(() => {
    window.location.hash = "#/agent/agent-beta";
  });
  await ctx.page.waitForTimeout(600);
  const multi = await ctx.page.evaluate(readForm, CONTROL_SELECTORS);
  if (multi !== null) {
    outcomes.push(
      outcome(
        "control-ask-user-tabs-per-question",
        multi.tabs === 3 && multi.questions === 3,
        `tabs=${multi.tabs} questions=${multi.questions}`,
      ),
      outcome(
        "control-ask-user-multi-submit-gated",
        multi.submitDisabled === true,
        `submitDisabled=${String(multi.submitDisabled)}`,
      ),
    );
  }
  // Restore the scenario route for later check modules (same discipline as checks-e2e.ts).
  await ctx.page.evaluate(() => {
    window.location.hash = "#/agent/agent-alpha";
  });
  await ctx.page.waitForTimeout(400);
  return outcomes;
}

/** §9.3/v2.1 §7.7 "命令模式": typing `/` into the composer opens the palette with policy
 * badges; a denied command never POSTs; `/session` (builtin bridge, sync captured output)
 * round-trips through `POST /api/cmd` and renders a `.command-result` with the output text. */
async function checkCommandMode(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "commands") return [];
  if (!isControlActionCell(ctx.scenario, ctx.width, ctx.hasTouch, ctx.theme)) return [];
  const page = asControlPage(ctx);
  const present = await page.evaluate((sel) => document.querySelector(sel.composer) !== null, CONTROL_SELECTORS);
  if (!present) return [];
  const results: CheckOutcome[] = [];

  const clearComposer = async (): Promise<void> => {
    await page.click(CONTROL_SELECTORS.composer);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  };

  // 1. palette opens with a policy badge for an allow command.
  await page.click(CONTROL_SELECTORS.composer);
  await page.keyboard.type("/se");
  await page.waitForTimeout(300);
  const palette = await page.evaluate((sel) => {
    const el = document.querySelector(sel.commandPalette);
    if (!el) return null;
    const first = el.querySelector(".command-item");
    return {
      items: el.querySelectorAll(".command-item").length,
      policy: first?.querySelector(".policy-chip")?.textContent ?? null,
      outputBadge: first?.querySelector(".chip-muted")?.textContent ?? null,
    };
  }, CONTROL_SELECTORS);
  results.push(
    outcome(
      "control-command-palette-opens",
      palette !== null && palette.items >= 1 && palette.policy !== null,
      palette === null ? "palette never opened" : JSON.stringify(palette),
    ),
  );

  // 2. a denied command never reaches the wire (§4.6 "绝不回落为文本").
  await clearComposer();
  await page.keyboard.type("/quit");
  await page.waitForTimeout(300);
  let before = countControlPosts(ctx);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const denied = await page.evaluate((sel) => {
    const el = document.querySelector(sel.commandPalette);
    return el?.querySelector(".command-item.denied") !== null && el?.querySelector(".command-item.denied") !== undefined
      ? true
      : (el?.textContent ?? "").includes("Terminal only");
  }, CONTROL_SELECTORS);
  results.push(
    outcome(
      "control-command-deny-never-posts",
      countControlPosts(ctx) === before && denied,
      `posts ${before}→${countControlPosts(ctx)}, deniedShown=${denied}`,
    ),
  );

  // 3. /session executes and the captured output renders (CommandOutputWire entries, §4.9).
  await clearComposer();
  await page.keyboard.type("/session");
  await page.waitForTimeout(200);
  before = countControlPosts(ctx);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel.commandResult);
    return el === null ? null : { state: el.getAttribute("data-state"), text: (el.textContent ?? "").slice(0, 300) };
  }, CONTROL_SELECTORS);
  results.push(
    outcome(
      "control-command-result-output",
      countControlPosts(ctx) === before + 1 &&
        result !== null &&
        result.state === "done" &&
        result.text.includes("sess-alpha"),
      `posts ${before}→${countControlPosts(ctx)}, result=${JSON.stringify(result)}`,
    ),
  );
  return results;
}

/** §9.3 "TopBar chip 切换": with control negotiated the top bar shows the Control chip (never
 * the Read-only one); exactly one of the two may be visible at a time. */
async function checkTopBarChip(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlScenario(ctx.scenario)) return [];
  const info = await ctx.page.evaluate((sel) => {
    const control = document.querySelector(sel.topbarControlChip);
    const readonly = document.querySelector(sel.topbarReadonlyChip);
    if (!control && !readonly) return null;
    return { control: control !== null, readonly: readonly !== null };
  }, CONTROL_SELECTORS);
  if (info === null) return [];
  return [
    outcome(
      "control-topbar-chip-exclusive",
      info.control !== info.readonly,
      `control=${info.control} readonly=${info.readonly}`,
    ),
  ];
}

/** v2.1 §7.7 hub-state banner: in the hub-states scenario the banner (once mounted) always has
 * visible text — the countdown ("最晚 HH:MM"), forced-upgrade and stopping copies are all
 * non-empty states, never a blank bar. */
async function checkHubStateBanner(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "hub-states") return [];
  const info = await ctx.page.evaluate((sel) => {
    const banner = document.querySelector(sel.hubStateBanner);
    if (banner === null) return null;
    return {
      state: banner.getAttribute("data-state") ?? "",
      text: (banner.textContent ?? "").trim(),
    };
  }, CONTROL_SELECTORS);
  if (info === null) return [];
  const out = [outcome("control-hub-state-banner-text", info.text.length > 0, "banner rendered empty")];
  // v2.1 §7.7: pending ⇒ countdown "最晚 HH:MM"; blocked ⇒ stop-marker pause note (D25 §6.7.3);
  // restarting ⇒ version + forced/draining note; stopping ⇒ the /webhub start pointer. The
  // fixture's script flips states at 0.8s/1.5s/30s, so which of the four a given cell sees is
  // timing-dependent — all four are well-formed.
  if (info.state === "pending") {
    out.push(
      outcome(
        "control-hub-state-countdown",
        /\d{2}:\d{2}/.test(info.text),
        `pending banner without HH:MM deadline: ${info.text.slice(0, 120)}`,
      ),
    );
  } else if (info.state === "blocked") {
    out.push(
      outcome(
        "control-hub-state-blocked-copy",
        /paused|\u6682\u505c/i.test(info.text) && info.text.includes("/webhub start"),
        `blocked banner missing pause note / /webhub start pointer: ${info.text.slice(0, 120)}`,
      ),
    );
  } else if (info.state === "restarting") {
    out.push(
      outcome(
        "control-hub-state-restarting-copy",
        info.text.includes("1.6.0") && /forced|Draining/i.test(info.text),
        `restarting banner missing version/forced note: ${info.text.slice(0, 120)}`,
      ),
    );
  } else if (info.state === "stopping") {
    out.push(
      outcome(
        "control-hub-state-stopping-copy",
        info.text.includes("/webhub start"),
        `stopping banner missing /webhub start: ${info.text.slice(0, 120)}`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// axe (same injection rationale as checks-e2e.ts — CDP evaluate is not governed by page CSP)
// ---------------------------------------------------------------------------

let cachedAxeSource: string | undefined;

function axeSource(): string {
  if (cachedAxeSource === undefined) {
    cachedAxeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  }
  return cachedAxeSource;
}

interface StringEvalPage {
  evaluate(script: string): Promise<unknown>;
}

async function checkControlAxe(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlAxeCell(ctx.scenario, ctx.width, ctx.hasTouch)) return [];
  const mounted = await ctx.page.evaluate(() => document.querySelector(".app, .login-page") !== null);
  if (!mounted) return [];
  const page = ctx.page;
  const suffix = `${ctx.width}x${ctx.theme}`;
  let violations: readonly AxeViolationLike[];
  try {
    await (page as unknown as StringEvalPage).evaluate(axeSource());
    const raw = await page.evaluate(async () => {
      const w = window as unknown as {
        axe?: { run(context: unknown, options: unknown): Promise<{ violations: readonly unknown[] }> };
      };
      if (w.axe === undefined) return null;
      const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      return r.violations;
    });
    if (raw === null) {
      return [outcome(`control-axe-wcag2-${suffix}`, false, "axe-core source evaluated but window.axe is undefined")];
    }
    violations = raw as readonly AxeViolationLike[];
  } catch (err) {
    return [outcome(`control-axe-wcag2-${suffix}`, false, `axe audit threw: ${String(err)}`)];
  }
  return [
    outcome(
      `control-axe-wcag2-${suffix}`,
      violations.length === 0,
      violations.length === 0 ? undefined : `${violations.length} violation(s): ${formatAxeViolations(violations)}`,
    ),
  ];
}

export const check: CheckModule = {
  id: "control",
  async run(ctx: CheckContext): Promise<CheckOutcome[]> {
    if (!isControlScenario(ctx.scenario)) return [];
    const outcomes: CheckOutcome[] = [];
    outcomes.push(...(await checkDockDoesNotCoverLastMessage(ctx)));
    outcomes.push(...(await checkControlNoticePersistent(ctx)));
    outcomes.push(...(await checkStopButtonTwoStep(ctx)));
    outcomes.push(...(await checkComposerKeys(ctx)));
    outcomes.push(...(await checkAskUserFormStructure(ctx)));
    outcomes.push(...(await checkCommandMode(ctx)));
    outcomes.push(...(await checkTopBarChip(ctx)));
    outcomes.push(...(await checkHubStateBanner(ctx)));
    outcomes.push(...(await checkControlAxe(ctx)));
    return outcomes;
  },
};

// ---------------------------------------------------------------------------
// --probe sub-mode (K16 Origin echo, K18 crypto availability)
// ---------------------------------------------------------------------------

export interface ProbeReport {
  readonly probe: string;
  readonly ok: boolean;
  readonly [k: string]: unknown;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly reports: readonly ProbeReport[];
}

const PROBE_INDEX_HTML =
  '<!doctype html><html data-auth-mode="__AUTH_MODE__"><head><meta charset="utf-8"><title>pwh probe</title></head><body>probe</body></html>';

/** First non-internal IPv4 (K18 needs a genuinely non-loopback origin: 127/8 and `localhost` are
 * potentially trustworthy, so probing over loopback would mask the LAN plain-HTTP case). */
function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

interface CryptoProbeShape {
  readonly randomUUID: string;
  readonly getRandomValues: string;
  readonly secureContext: boolean;
}

/**
 * K18, LAN half (control-plan.md §2.1) — a REAL assertion, not a note: over plain HTTP on a
 * non-loopback origin the page must NOT be a secure context, `crypto.randomUUID`
 * ([SecureContext]-only) must be ABSENT, and `crypto.getRandomValues` (the one `newCmdId`
 * actually depends on, §3.4) must still work. The only route is a throwaway server bound to
 * 0.0.0.0, visited through this machine's real LAN IP (`http://<lan-ip>:<port>`) — a fake
 * origin (e.g. a `--host-resolver-rules`-mapped `.invalid` hostname) would only re-prove the
 * loopback case and is NOT accepted. With no non-loopback interface (e.g. a sandboxed CI
 * container) the probe reports an explicit SKIP (`ok:false`, `via:"skip-no-lan"`) so the
 * absence of evidence is visible in the report instead of being laundered into a pass.
 */
async function probeLanPlainHttpCrypto(
  chromium: PwChromium,
  executablePath: string,
  browser: PwBrowser,
): Promise<ProbeReport> {
  const lanIp = firstLanIPv4();
  if (lanIp === undefined) {
    return {
      probe: "k18-crypto-lan-plain-http",
      engine: "chromium",
      origin: "",
      via: "skip-no-lan",
      randomUUID: "",
      getRandomValues: "",
      secureContext: false,
      ok: false,
      note: "SKIP: no non-loopback IPv4 interface — the LAN plain-HTTP crypto invariants were NOT verified on this machine",
    };
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PROBE_INDEX_HTML.replace("__AUTH_MODE__", "token"));
  });
  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(0, "0.0.0.0", () => resolveP());
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const origin = `http://${lanIp}:${port}`;
    const via = "lan-ip";
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(origin + "/", { waitUntil: "load" });
    const probe = await page.evaluate(() => ({
      randomUUID: typeof window.crypto?.randomUUID,
      getRandomValues: typeof window.crypto?.getRandomValues,
      secureContext: window.isSecureContext,
    }));
    await context.close();
    return {
      probe: "k18-crypto-lan-plain-http",
      engine: "chromium",
      origin,
      via,
      ...probe,
      ok: probe.secureContext === false && probe.randomUUID === "undefined" && probe.getRandomValues === "function",
      note: "plain HTTP off-loopback is not a secure context: randomUUID must be absent (SecureContext-only), getRandomValues must survive (frontend newCmdId depends on it)",
    };
  } finally {
    await new Promise<void>((resolveP) => server.close(() => resolveP()));
  }
}

/**
 * K16: a same-origin `fetch` POST to `/api/cmd` from a real browser must carry
 * `Origin: http://127.0.0.1:<port>` (loopback write gate, §6.3 D8) and, when the engine sends
 * one, `Sec-Fetch-Site: same-origin`. K18: `crypto.getRandomValues` must exist even where
 * `crypto.randomUUID` doesn't — asserted for real on both halves: loopback (secure context, both
 * present) and LAN plain HTTP via `probeLanPlainHttpCrypto` (`http://<lan-ip>` or a
 * resolver-mapped `.invalid` fallback: not a secure context, `randomUUID` absent,
 * `getRandomValues` — the one the frontend's `newCmdId` depends on — present).
 */
export async function runControlProbe(
  opts: { log?: (line: string) => void } = {},
): Promise<{ readonly kind: "ok"; result: ProbeResult } | { readonly kind: "browser-unavailable"; reason: string }> {
  const log = opts.log ?? (() => {});
  const pw = await loadPlaywright();
  if (!pw.ok) return { kind: "browser-unavailable", reason: pw.reason };

  const rootDir = mkdtempSync(join(tmpdir(), "pwh-control-probe-"));
  let hub: DevHubHandle | undefined;
  let browser: PwBrowser | undefined;
  try {
    writeFileSync(join(rootDir, "index.html"), PROBE_INDEX_HTML);
    hub = await createDevHub({ mode: "token", scenario: "control", root: rootDir, log: () => {} });
    if (hub.token === undefined) throw new Error("probe: dev-hub returned no token in token mode");
    const token = hub.token;
    browser = await pw.chromium.launch({ headless: true, executablePath: pw.executablePath });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = (await context.newPage()) as unknown as ExtPage;
    await page.goto(hub.url + "/", { waitUntil: "load" });

    const loginStatus = await page.evaluate(
      async (args) => {
        const res = await fetch(args.url + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify({ token: args.token }),
        });
        return res.status;
      },
      { url: hub.url, token },
    );
    if (loginStatus !== 200) throw new Error(`probe: login failed with HTTP ${loginStatus}`);

    const cmdId = randomBytes(16).toString("base64url");
    const cmdStatus = await page.evaluate(
      async (args) => {
        const res = await fetch(args.url + "/api/cmd", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify({
            agentKey: "agent-alpha",
            id: args.cmdId,
            op: "prompt",
            text: "k16 origin probe",
          }),
        });
        return res.status;
      },
      { url: hub.url, cmdId },
    );

    const recorded = hub.controlRequests().find((r) => r.id === cmdId);
    const cryptoProbe: CryptoProbeShape = await page.evaluate(() => ({
      randomUUID: typeof window.crypto?.randomUUID,
      getRandomValues: typeof window.crypto?.getRandomValues,
      secureContext: window.isSecureContext,
    }));
    const lanCrypto = await probeLanPlainHttpCrypto(pw.chromium, pw.executablePath, browser);

    const reports: ProbeReport[] = [
      {
        probe: "k16-origin-echo",
        engine: "chromium",
        httpStatus: cmdStatus,
        origin: recorded?.origin ?? null,
        secFetchSite: recorded?.secFetchSite ?? null,
        ok:
          cmdStatus === 200 &&
          recorded?.origin === hub.url &&
          (recorded.secFetchSite === undefined || recorded.secFetchSite === "same-origin"),
        note: "chromium only — firefox/webkit rows are W5 真机 (control-plan.md §2.1 K16)",
      },
      {
        probe: "k18-crypto",
        ...cryptoProbe,
        ok:
          cryptoProbe.secureContext === true &&
          cryptoProbe.randomUUID === "function" &&
          cryptoProbe.getRandomValues === "function",
        note: "127.0.0.1 is a secure context so BOTH exist here; the LAN plain-HTTP case (randomUUID absent, getRandomValues present) is asserted by the k18-crypto-lan-plain-http probe below",
      },
      lanCrypto,
    ];
    log(JSON.stringify(reports));
    return { kind: "ok", result: { ok: reports.every((r) => r.ok), reports } };
  } finally {
    await browser?.close();
    await hub?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

const PROBE_HELP = `Usage: npx tsx scripts/web-hub/visual/checks-control.ts --probe

K16 (Origin echo) + K18 (crypto availability) browser probes against a throwaway dev-hub
(control-plan.md §9.3). Prints one JSON array of probe reports; exit 0 = all ok, 1 = a probe
assertion failed, 2 = browser unavailable.`;

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(PROBE_HELP);
  } else if (!argv.includes("--probe")) {
    console.error("checks-control.ts is a visual-harness module; the only direct CLI mode is --probe.");
    console.error(PROBE_HELP);
    process.exitCode = 2;
  } else {
    runControlProbe({ log: (line) => console.log(line) })
      .then((r) => {
        if (r.kind === "browser-unavailable") {
          console.error(`✗ browser unavailable: ${r.reason}`);
          process.exitCode = 2;
          return;
        }
        console.log(
          r.result.reports.map((rep) => `  ${rep.ok ? "✓" : "✗"} ${rep.probe}: ${JSON.stringify(rep)}`).join("\n"),
        );
        process.exitCode = r.result.ok ? 0 : 1;
      })
      .catch((err: unknown) => {
        console.error(err);
        process.exitCode = 2;
      });
  }
}
