// Jev-facing copy: injection messages and markers, gate reasons, write echo,
// status lines, notifications and the `/mem jev` report (jev-arch §5.3,
// §6.1.6, §6.2.4, §6.4.4, §6.4.5, §9.4 — texts are VERBATIM from the
// architecture doc; tests compare them literally). Copy is centralized here
// so goldens and i18n stays put (AGENTS.md “UI text language split”: compact
// inline markers are English tokens; Chinese is reserved for prose blocks
// aimed at the user/model).
//
// Pi-free root; pure functions only, no module state (I4).

import {
  SEGMENT_MAX_INJECTED,
  type EntryType,
  type Importance,
  type InjectLayer,
  type JevReportView,
  type JevStatus,
} from "./contracts.js";
import { IMPORTANCE_LABELS } from "./taxonomy.js";

// ───────────────────────────── inject message & marker (§6.1.6) ─────────────────────────────

export interface InjectItem {
  readonly anchor: string;
  readonly body: string;
  /** Jev probability, when the layer has one (U/E). */
  readonly p?: number;
  /** Expired entry — title gets the「已到期，待用户确认」note (Q1). */
  readonly expired?: boolean;
  /** B-layer re-injection of an edited entry —「（已修改）」(§6.1.5). */
  readonly modified?: boolean;
}

/** The injected message body: the fixed first line (layer-parameterized,
 *  verbatim §6.1.6) followed by one block per entry. */
export function formatInjectMessage(layer: InjectLayer, items: readonly InjectItem[]): string {
  const head = `[memory · ${layer} jev] 以下是与当前请求相关的项目记忆条目（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。`;
  if (items.length === 0) return head;
  const blocks = items.map((item) => {
    const note =
      item.expired === true && item.modified === true
        ? "（已到期，待用户确认）（已修改）"
        : item.expired === true
          ? "（已到期，待用户确认）"
          : item.modified === true
            ? "（已修改）"
            : "";
    return `${item.anchor}${note}\n${item.body}`;
  });
  return `${head}\n\n${blocks.join("\n\n")}`;
}

/** The user-visible one-line TUI marker, e.g. `── mem U: pitfalls-git › #3
 *  (0.81) ──`; zero-call layers during `partial` get the `·partial` suffix
 *  (§5.3), e.g. `── mem A·partial: pitfalls-git › #3 ──`. */
export function formatInjectMarker(
  layer: InjectLayer,
  items: readonly { anchor: string; p?: number }[],
  opts?: { partial?: boolean },
): string {
  const inner = items
    .map((item) => `${item.anchor}${item.p === undefined ? "" : ` (${item.p.toFixed(2)})`}`)
    .join(", ");
  return `── mem ${layer}${opts?.partial === true ? "·partial" : ""}: ${inner} ──`;
}

// ───────────────────────────── gate copy (§6.4.4 / §6.4.5) ─────────────────────────────

function authorityCn(authority: "user" | "agent"): string {
  return authority === "user" ? "用户令" : "经验";
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mmdd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m === null ? iso : `${m[2]}-${m[3]}`;
}

export interface GateReasonEntry {
  readonly anchor: string;
  readonly authority: "user" | "agent";
  readonly a: number;
  readonly v: number;
}

/** Jev-judged block reasons (§6.4.4), verbatim. `once`: the one-shot block
 *  (latched for this turn); `hold`: condition judged to hold right now;
 *  `hold-evidence`: Jev could not judge (timeout/error/partial, Q33) but a
 *  `gate=hold` rule's named program is running (§6.4.5). */
export function formatGateReason(
  kind: "once" | "hold" | "hold-evidence",
  args: {
    readonly tool: string;
    readonly entries: readonly GateReasonEntry[];
    /** `hold`/`hold-evidence`: the running evidence lines (already redacted). */
    readonly evidence?: readonly string[];
    /** `hold-evidence` only: why Jev did not judge (e.g. "timeout", "partial"). */
    readonly why?: string;
  },
): string {
  const tool = args.tool;
  if (kind === "once") {
    const list = args.entries
      .map((e) => `「${e.anchor}」（${authorityCn(e.authority)}，applies ${e.a.toFixed(2)}）`)
      .join("、");
    return `[memory gate] 本次 ${tool} 调用未执行：Jev 判定它属于记忆规则${list}的管辖范围。规则正文紧随其后以 [memory] 消息给出（已在系统提示中的规则不再重复）。请逐条核对：全部满足就在下一步原样重试（看过正文后的重试不会再拦；同一批里并发的相同调用也已一并拦下）；有不满足的，调整方案或先问用户。`;
  }
  const evidence = (args.evidence ?? []).join("；");
  if (kind === "hold") {
    const e = args.entries[0];
    return `[memory gate·hold] 本次 ${tool} 调用未执行：规则「${e?.anchor ?? ""}」（${authorityCn(e?.authority ?? "user")}）的条件仍成立（violates_now ${(e?.v ?? 0).toFixed(2)}；证据：${evidence}）。本次及后续重试都会被拦，直到条件消失。请等待（如用 bash_job list 查看进度），不要反复重试；确需继续请先问用户。`;
  }
  const e = args.entries[0];
  return `[memory gate·hold] 本次 ${tool} 调用未执行：Jev 未判定（${args.why ?? "unavailable"}），按证据拦截——规则「${e?.anchor ?? ""}」（${authorityCn(e?.authority ?? "user")}，gate=hold）点名的程序正在运行：${evidence}。本次及后续重试都会被拦，直到该程序结束。请等待，不要反复重试；确需继续请先问用户。`;
}

/** Evidence-tier fallback (§6.4.5): let the call through but hand the rule
 *  bodies over as “unjudged” — first line verbatim. */
export function formatUnjudged(items: readonly { anchor: string; body: string }[]): string {
  const head = "[memory · G unjudged] Jev 未能判定，以下规则请自行核对";
  if (items.length === 0) return head;
  return `${head}\n\n${items.map((item) => `${item.anchor}\n${item.body}`).join("\n\n")}`;
}

// ───────────────────────────── write echo (§6.2.4) ─────────────────────────────

export interface WriteEchoAnchor {
  readonly file: string;
  readonly ordinal: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface WriteEchoTagged {
  readonly kind: "tagged";
  readonly anchor: WriteEchoAnchor;
  readonly type: EntryType;
  readonly typeP: number;
  readonly importance: Importance;
  readonly tags: readonly { id: string; p: number }[];
  readonly guard: number;
  readonly temporal: "permanent" | "dated" | "event";
  readonly similar?: { anchor: string; relation: string; p: number };
  readonly userLike?: number;
  readonly authority: "user" | "agent";
  /** `expires`/`until` already present on the entry. */
  readonly hasExpiry?: boolean;
  readonly conflict?: { anchor: string; userRule: boolean; relation: string; p: number };
}

export interface WriteEchoNotTagged {
  readonly kind: "not-tagged";
  readonly anchor?: WriteEchoAnchor;
  /** e.g. "partial: 451" (long form) or "off: pi-api" (short form). */
  readonly reason: string;
  readonly long: boolean;
}

export type WriteEchoInput = WriteEchoTagged | WriteEchoNotTagged;

function anchorLine(anchor: WriteEchoAnchor): string {
  return `section: ${anchor.file} #${anchor.ordinal} (L${anchor.lineStart}-${anchor.lineEnd})`;
}

/** Post-write echo (§6.2.4): `section:` line, the `jev:` judgment line, the
 *  `similar:` line, then the conditional advice lines in table order. The
 *  not-tagged variant prints the §6.2.1/§9.2 lines instead of a judgment. */
export function formatWriteEcho(input: WriteEchoInput): string {
  if (input.kind === "not-tagged") {
    const lines: string[] = [];
    if (input.anchor !== undefined) lines.push(anchorLine(input.anchor));
    lines.push(
      input.long
        ? `jev: not tagged (${input.reason}) — fast path will not see this entry until tagged; inline tags=+… works now`
        : `jev: not tagged (${input.reason})`,
    );
    return lines.join("\n");
  }
  const tagList = input.tags.map((t) => `${t.id} ${t.p.toFixed(2)}`).join(", ");
  const lines: string[] = [
    anchorLine(input.anchor),
    [
      `jev: ${input.type} ${input.typeP.toFixed(2)}`,
      `· ${IMPORTANCE_LABELS[input.importance] ?? String(input.importance)}`,
      tagList === "" ? undefined : `· tags ${tagList}`,
      `· guard ${input.guard.toFixed(2)}`,
      `· ${input.temporal}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" "),
  ];
  if (input.similar !== undefined) {
    lines.push(`similar: ${input.similar.anchor} (${input.similar.relation} ${input.similar.p.toFixed(2)})`);
  }
  if (input.userLike !== undefined && input.userLike >= 0.8 && input.authority === "agent") {
    lines.push(
      `jev: looks like a user order (${input.userLike.toFixed(2)}) — if the user said it, append <!-- mem user -->`,
    );
  }
  if ((input.temporal === "dated" || input.temporal === "event") && input.hasExpiry !== true) {
    lines.push(`jev: looks temporary — add expires=YYYY-MM-DD or until="…"`);
  }
  const c = input.conflict;
  if (
    c !== undefined &&
    (c.relation === "duplicate" || c.relation === "conflict" || c.relation === "supersedes") &&
    c.p >= 0.75
  ) {
    lines.push(
      c.userRule
        ? `conflict: ${c.anchor} (user rule, ${c.relation} ${c.p.toFixed(2)}) — 用户令只有用户能作废：在回复里向用户提议具体改法`
        : `conflict: ${c.anchor} (agent entry, ${c.relation} ${c.p.toFixed(2)}) — consider merging into it or deleting the older entry in place`,
    );
  }
  if (input.guard >= 0.7) {
    lines.push(
      `jev: guards a risky action (${input.guard.toFixed(2)}) — pre-action review enabled; add gate=hold if it must block while a condition holds, nogate to opt out`,
    );
  }
  return lines.join("\n");
}

// ───────────────────────────── status line (§5.3) ─────────────────────────────

export interface StatusCoverage {
  readonly tagged: number;
  readonly total: number;
  readonly lastTaggedAt?: string;
  readonly retryAt?: number;
  readonly usage?: { readonly costUsd: number; readonly calls: number };
}

function coverageText(c: StatusCoverage, withDate = false): string {
  if (c.total <= 0) return "";
  // The (MM-DD) last-tagged date shows only on the partial line (§5.3).
  return `${c.tagged}/${c.total} tagged${withDate && c.lastTaggedAt !== undefined ? ` (${mmdd(c.lastTaggedAt)})` : ""}`;
}

/** The `/mem` default-list trailer line (English tokens only, §5.3 table). */
export function formatStatusLine(status: JevStatus, coverage: StatusCoverage): string {
  switch (status.kind) {
    case "off":
      switch (status.reason) {
        case "secure":
          return "jev: off (secure domain)";
        case "empty-list":
          return "jev: off (empty classifier list)";
        case "pi-api":
          return "jev: off (pi-api)";
        case "disabled":
          return "jev: off (disabled)";
        case "legacy":
          return "jev: off (legacy)";
      }
      return "jev: off";
    case "probing": {
      const cov = coverageText(coverage);
      return cov === "" ? "jev: probing" : `jev: probing · ${cov}`;
    }
    case "full": {
      const parts = [`jev: full · ${status.model}`];
      const cov = coverageText(coverage);
      if (cov !== "") parts.push(cov);
      if (coverage.usage !== undefined) {
        parts.push(`${coverage.usage.calls} calls $${coverage.usage.costUsd.toFixed(3)}`);
      }
      return parts.join(" · ");
    }
    case "partial": {
      if (status.inactive) return "jev: inactive (no classifier credentials)";
      const parts = [`jev: partial (${status.reason})`];
      const cov = coverageText(coverage, true);
      if (cov !== "") parts.push(`fast path ${cov}`);
      const retryAt = status.retryAt ?? coverage.retryAt;
      if (retryAt !== undefined) parts.push(`retry ${hhmm(retryAt)}`);
      parts.push("/mem jev");
      return parts.join(" · ");
    }
  }
}

// ───────────────────────────── notifications (§5.3 table) ─────────────────────────────

/** The four `ctx.ui.notify` texts (main session + UI only — sending them is
 *  the caller's job, J6). */
export function formatNotify(
  kind: "first-full" | "degraded" | "recovered" | "startup-partial",
  info: { model?: string; reason?: string; tagged?: number; total?: number },
): string {
  switch (kind) {
    case "first-full":
      return `jev on · ${info.model ?? ""} — 记忆召回、打标、整理、高危拦截已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭`;
    case "degraded":
      return `jev partial (${info.reason ?? ""}) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（${info.tagged ?? 0}/${info.total ?? 0}）。/mem jev`;
    case "recovered":
      return `jev recovered · ${info.model ?? ""}`;
    case "startup-partial": {
      const base = `jev partial (${info.reason ?? ""}) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（${info.tagged ?? 0}/${info.total ?? 0}）。/mem jev`;
      // 451-style status codes get the regional-block troubleshooting hint
      // (§5.3 startup row); non-numeric reasons go out without it.
      return /^\d+$/.test(info.reason ?? "") ? `${base}（${info.reason} 多为地区拦截，可设 memory.jev.proxy）` : base;
    }
  }
}

// ───────────────────────────── `/mem jev` report (§9.4) ─────────────────────────────

function reportLine(label: string, content: string, cont?: string): string[] {
  const first = `${label.padEnd(8, " ")} ${content}`;
  return cont === undefined ? [first] : [first, `${"".padEnd(9, " ")}${cont}`];
}

/** The `/mem jev` two-column report, verbatim §9.4 layout (labels padded to
 *  8 + 1 spaces; model rows numbered, id column padded to the widest id). */
export function formatJevReport(view: JevReportView): string {
  const lines: string[] = [];
  lines.push(...reportLine("jev", view.status));
  if (view.models.length > 0) {
    // Id column: widest id + 3 spaces, so notes align (§9.4 example).
    const width = Math.max(...view.models.map((m) => m.id.length)) + 3;
    view.models.forEach((m, i) => {
      const row = `${i + 1} ${m.id.padEnd(width, " ")}${m.note ?? ""}`;
      if (i === 0) lines.push(`models   ${row}`);
      else lines.push(`${"".padEnd(9, " ")}${row}`);
    });
  }
  if (view.stopped.length > 0) lines.push(`stopped  ${view.stopped.join(" · ")}`);
  if (view.running.length > 0) lines.push(`running  ${view.running.join(" · ")}`);
  const tagParts = [`${view.tags.tagged}/${view.tags.total} tagged`];
  if (view.tags.pending > 0) tagParts.push(`${view.tags.pending} pending (edited since last tagging)`);
  if (view.tags.lastTaggedAt !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}:\d{2})?/.exec(view.tags.lastTaggedAt);
    tagParts.push(
      m === null
        ? `last tagged ${view.tags.lastTaggedAt}`
        : `last tagged ${m[2]}-${m[3]}${m[4] === undefined ? "" : ` ${m[4]}`}`,
    );
  }
  tagParts.push(`taxonomy ${view.tags.taxonomyRev}`);
  lines.push(`tags     ${tagParts.join(" · ")}`);
  lines.push(`evidence ${view.evidence}`);
  lines.push(
    `usage    ${view.usage.calls} calls · $${view.usage.costUsd.toFixed(4)} / $${view.usage.maxCostUsd.toFixed(2)} · per activation (/reload resets)`,
  );
  const layerCounts = (["U", "A", "E", "B", "G"] as const)
    .map((layer) =>
      (view.segment.injectedByLayer[layer] ?? 0) > 0 ? `${layer}${view.segment.injectedByLayer[layer]}` : undefined,
    )
    .filter((part): part is string => part !== undefined)
    .join(" ");
  lines.push(
    `segment  injected ${view.segment.injectedTotal}${layerCounts === "" ? "" : ` (${layerCounts})`} · gates ${view.segment.gates} (hold ${view.segment.holdGates}) · cap ${view.segment.injectedTotal}/${SEGMENT_MAX_INJECTED} · verdict cache ${view.segment.verdictCache}`,
  );
  const reviewParts: string[] = [];
  if (view.review.lastRunAt !== undefined) reviewParts.push(`last ${view.review.lastRunAt}`);
  reviewParts.push(`${view.review.open} open → /mem review`);
  lines.push(`review   ${reviewParts.join(" · ")}`);
  return lines.join("\n");
}
