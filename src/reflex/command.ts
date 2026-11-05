/**
 * jev-reflex · `/reflex` command (plan R2b step 4; arch §4.11): `status` (default) | `explain <text>` | `reset [id]`.
 * Output goes through `ctx.ui.notify` (command capture mirrors it to the web). Chinese prose + English compact
 * tokens (AGENTS.md UI-language split). Pure of pi runtime state: everything arrives through `ReflexCommandDeps`.
 */
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { evaluateGate } from "./core/gate.js";
import type { Matcher } from "./core/match.js";
import { accumulate, evaluatePromotion, msPercentiles, type PromotionRow, type ScriptStats } from "./core/promotion.js";
import type {
  Capability,
  DraftLoadResult,
  ReflexAnswerDetailsV1,
  ReflexCorrectionV1,
  ReflexRecordV1,
  ReflexStatusSnapshot,
  RScriptV1,
} from "./core/types.js";

export interface ReflexCommandDeps {
  enabled(): boolean;
  autoResolve(): readonly string[];
  snapshot(): ReflexStatusSnapshot;
  catalog: readonly RScriptV1[];
  matcher: Matcher;
  capabilities(): ReadonlySet<Capability>;
  /** Clears strikes + demote overlay (all scripts when `id` is undefined). Returns false for an unknown id. */
  reset(id?: string): boolean;
  /**
   * #25 runtime drafts. Absent or `enabled()===false` ⇒ every draft-related output below is skipped, so
   * `/reflex status` stays byte-identical to the pre-drafts text (drafts-off parity).
   */
  drafts?: {
    enabled(): boolean;
    dir(): string;
    /** `undefined` ⇒ not loaded yet (or the load was aborted and will be retried). */
    result(): DraftLoadResult | undefined;
    loading(): boolean;
    counters(): { candidates: number; ambiguous: number; reasked: number; corrected: number };
  };
}

const COUNTER_ORDER = ["candidates", "answered", "ambiguous", "repeat", "reasked", "corrected"] as const;

/** Which template matched, for `explain`: `strong#i` / `weak#i` (0-based, catalog order). */
function matchedTemplate(script: RScriptV1, norm: string): string {
  const strong = script.intent.strong.findIndex((src) => new RegExp(`^(?:${src})$`).test(norm));
  if (strong >= 0) return `strong#${strong}`;
  const weak = script.intent.weak.findIndex((src) => new RegExp(src).test(norm));
  return weak >= 0 ? `weak#${weak}` : "none";
}

export function explainText(deps: ReflexCommandDeps, text: string): string {
  if (text.trim() === "") return "用法：/reflex explain <文本>（按理想 TUI 空闲事实跑 S0+S1，不执行 port）";
  const gate = evaluateGate({
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  });
  if (!gate.pass) return `reflex explain: veto=${gate.veto}`;
  const m = deps.matcher.match(gate.norm.norm, deps.capabilities());
  if (m.kind === "miss") return "reflex explain: miss（S1 无命中）";
  const parts = m.candidates.map((id) => {
    const script = deps.catalog.find((s) => s.id === id);
    return `${id}（${script === undefined ? "?" : matchedTemplate(script, gate.norm.norm)}）`;
  });
  return `reflex explain: band=${m.band} script=${m.scriptId} candidates=${parts.join(", ")}`;
}

/** Fold this session's reflex entries (custom / custom_message in `getBranch()`) into promotion stats. */
function branchStats(branch: readonly unknown[]): { stats: Map<string, ScriptStats>; samples: Map<string, number[]> } {
  const stats = new Map<string, ScriptStats>();
  const samples = new Map<string, number[]>();
  const sample = (key: string, ms: unknown): void => {
    if (typeof ms === "number" && Number.isFinite(ms)) samples.set(key, [...(samples.get(key) ?? []), ms]);
  };
  for (const raw of branch) {
    const e = raw as { type?: unknown; customType?: unknown; data?: unknown; details?: unknown } | null;
    if (e === null || typeof e !== "object") continue;
    let row: PromotionRow | undefined;
    if (
      e.type === "custom" &&
      e.customType === "subagent:reflex-record" &&
      e.data !== null &&
      typeof e.data === "object"
    ) {
      const rec = e.data as ReflexRecordV1;
      row = { kind: "record", rec };
      if (rec.kind === "shadow") sample(`${rec.scriptId}@${rec.scriptVer}`, rec.port?.ms);
    } else if (
      e.type === "custom" &&
      e.customType === "subagent:reflex-correction" &&
      e.data !== null &&
      typeof e.data === "object"
    ) {
      row = { kind: "correction", c: e.data as ReflexCorrectionV1 };
    } else if (
      e.type === "custom_message" &&
      e.customType === "subagent:reflex" &&
      e.details !== null &&
      typeof e.details === "object"
    ) {
      const details = e.details as ReflexAnswerDetailsV1;
      row = { kind: "answer", details };
      sample(`${details.scriptId}@${details.scriptVer}`, details.ms);
    }
    if (row !== undefined) accumulate(stats, row);
  }
  for (const [key, s] of stats) {
    const p = msPercentiles(samples.get(key) ?? []);
    if (p.p50 !== undefined) s.p50ms = p.p50;
    if (p.p95 !== undefined) s.p95ms = p.p95;
  }
  return { stats, samples };
}

export function statusText(deps: ReflexCommandDeps, branch: readonly unknown[]): string {
  const snap = deps.snapshot();
  const auto = deps.autoResolve();
  const lines: string[] = [];
  lines.push(
    `reflex: ${snap.enabled ? "enabled" : "disabled"} · autoResolve=${auto.length === 0 ? "-" : auto.join(",")} · gen ${snap.generation}`,
  );
  lines.push("脚本状态（shadow 只记账不作答；auto 命中时直接作答，失败两次/重复/被纠正自动降回 shadow）：");
  for (const s of snap.scripts) {
    lines.push(
      `  ${s.id} ${s.state} strikes=${s.strikes}${s.demoteReason !== undefined ? ` demote=${s.demoteReason}` : ""}`,
    );
  }
  const counters = snap.counters;
  const counterParts: string[] = COUNTER_ORDER.map((k) => `${k}=${counters[k] ?? 0}`);
  const fb = Object.keys(counters)
    .filter((k) => k.startsWith("fallback."))
    .sort()
    .map((k) => `${k}=${counters[k]}`);
  lines.push(`本激活计数：${counterParts.join(" ")} fallback=${fb.length === 0 ? "0" : fb.join(",")}`);
  if (deps.drafts?.enabled() === true) {
    const d = deps.drafts;
    const res = d.result();
    const c = d.counters();
    const loadState = res === undefined ? (d.loading() ? "loading" : "not-loaded") : `loaded=${res.loaded.length}`;
    const failed = res?.failure !== undefined ? ` failure=${res.failure.code}` : "";
    lines.push(
      `草案：enabled · ${loadState} rejected=${res?.rejected.length ?? 0}${failed} · candidates=${c.candidates} ambiguous=${c.ambiguous} reasked=${c.reasked} corrected=${c.corrected}（草案恒 shadow：draft.* 不可自动作答，详见 /reflex drafts）`,
    );
    if (auto.some((id) => id.startsWith("draft."))) {
      lines.push("autoResolve 含 draft.* id：草案不参与自动作答，已忽略。");
    }
  }

  const { stats } = branchStats(branch);
  lines.push("本会话记录（getBranch）：");
  if (stats.size === 0) lines.push("  （无）");
  for (const [key, s] of [...stats].sort(([a], [b]) => a.localeCompare(b))) {
    const agreeRate = s.judged > 0 ? `${Math.round((s.agree / s.judged) * 100)}%` : "-";
    lines.push(
      `  ${key} cand=${s.candidates} port_ok=${s.portOk}/${s.portRuns} agree=${agreeRate}(${s.agree}/${s.judged}) ` +
        `diverge=${s.diverge} unknown=${s.unknown} reasked=${s.reasked} corrected=${s.corrected} answered=${s.answered} ` +
        `p50=${s.p50ms ?? "-"}ms p95=${s.p95ms ?? "-"}ms`,
    );
    const verdict = evaluatePromotion(s);
    lines.push(`    promotion: ${verdict.eligible ? "eligible" : `not eligible（${verdict.reasons.length} 项未过）`}`);
  }
  lines.push("晋升判定：本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`（R3b）。");
  if (snap.unknownAutoResolve.length > 0) {
    lines.push(`autoResolve 含未知 id（已忽略）：${snap.unknownAutoResolve.join(", ")}`);
  }
  return lines.join("\n");
}

/** `/reflex drafts` text: loaded `<id>@<ver>#<templateHash8> port=<p>` + rejected `<file> <code>`. */
export function draftsText(deps: ReflexCommandDeps): string {
  const d = deps.drafts;
  if (d === undefined || !d.enabled()) return "reflex drafts: disabled（reflex.drafts.enabled=false）";
  const res = d.result();
  const lines: string[] = [];
  if (res === undefined) {
    lines.push(
      `reflex drafts: enabled · ${d.loading() ? "loading…" : "尚未加载（session_start 时加载一次）"} · dir=${d.dir()}`,
    );
    return lines.join("\n");
  }
  lines.push(
    `reflex drafts: enabled · loaded ${res.loaded.length} · rejected ${res.rejected.length}${res.failure !== undefined ? ` · failure ${res.failure.code}${res.failure.detail !== undefined ? ` (${res.failure.detail})` : ""}` : ""} · dir=${d.dir()}`,
  );
  for (const l of res.loaded) {
    lines.push(`  loaded ${l.script.id}@${l.script.version}#${l.templateHash.slice(0, 8)} port=${l.script.port.id}`);
  }
  for (const r of res.rejected) {
    lines.push(`  rejected ${r.file} ${r.code}${r.detail !== undefined ? ` (${r.detail.slice(0, 80)})` : ""}`);
  }
  if (res.loaded.length === 0 && res.rejected.length === 0 && res.failure === undefined)
    lines.push("  （目录为空或不存在）");
  lines.push("草案恒 shadow；改动草案文件后需 /reload 才会重新加载。");
  return lines.join("\n");
}

export function createReflexCommand(deps: ReflexCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "reflex：/reflex [status] | explain <文本> | reset [id] —— 只读自省问题的确定性作答层（shadow）。",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const trimmed = (args ?? "").trim();
        const spaceAt = trimmed.search(/\s/);
        const sub = (spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
        const rest = spaceAt < 0 ? "" : trimmed.slice(spaceAt).trim();
        let out: string;
        if (sub === "" || sub === "status") {
          let branch: readonly unknown[] = [];
          try {
            branch = ctx.sessionManager.getBranch();
          } catch {
            /* no session manager ⇒ counters only */
          }
          out = statusText(deps, branch);
        } else if (sub === "explain") {
          out = explainText(deps, rest);
        } else if (sub === "drafts") {
          out = draftsText(deps);
        } else if (sub === "reset") {
          const id = rest === "" ? undefined : rest;
          out =
            id !== undefined && id.startsWith("draft.") && deps.drafts?.enabled() === true
              ? `reflex: 草案「${id}」没有降级状态（draft.* 恒 shadow，无 strikes / 覆盖层可清）`
              : deps.reset(id)
                ? `reflex: reset ${id ?? "all"}（strikes 与降级覆盖层已清）`
                : `reflex: 未知脚本 id「${id}」`;
        } else {
          out =
            deps.drafts?.enabled() === true
              ? "用法：/reflex [status] | explain <文本> | reset [id] | drafts"
              : "用法：/reflex [status] | explain <文本> | reset [id]";
        }
        ctx.ui.notify(out, "info");
      } catch {
        /* best-effort: a command handler never throws past here */
      }
    },
  };
}
