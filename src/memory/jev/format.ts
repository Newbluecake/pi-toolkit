// Jev-facing copy: injection messages and markers, write echo, status
// lines, notifications and the `/mem jev` report (jev-arch §5.3, §6.1.6,
// §6.2.4, §9.4 — texts are VERBATIM from the architecture doc; tests compare
// them literally). The gate-reason/unjudged copy was removed with the gate
// feature (2026-11). Copy is centralized here so goldens and i18n stays put
// (AGENTS.md “UI text language split”: compact inline markers are English
// tokens; Chinese is reserved for prose blocks aimed at the user/model).
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
  /** S state-constraint entry (release in progress) —「（发版进行中）」
   *  (memory-predict plan §3.4). */
  readonly releaseInProgress?: boolean;
}

/** P-layer header, verbatim memory-predict plan §5.3 (P predicts from the
 *  current task state — it does NOT reuse the generic U "与当前请求相关"
 *  template). */
const P_HEAD =
  "[memory · P jev] 以下是根据当前任务状态预测本轮可能用到的项目记忆（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。";

/** The injected message body: the fixed first line (layer-parameterized,
 *  verbatim §6.1.6; P uses the plan §5.3 line) followed by one block per
 *  entry. */
export function formatInjectMessage(layer: InjectLayer, items: readonly InjectItem[]): string {
  const head =
    layer === "P"
      ? P_HEAD
      : `[memory · ${layer} jev] 以下是与当前请求相关的项目记忆条目（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。`;
  if (items.length === 0) return head;
  const blocks = items.map((item) => {
    const note =
      (item.expired === true && item.modified === true
        ? "（已到期，待用户确认）（已修改）"
        : item.expired === true
          ? "（已到期，待用户确认）"
          : item.modified === true
            ? "（已修改）"
            : "") + (item.releaseInProgress === true ? "（发版进行中）" : "");
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
  return `── mem ${layer}${opts?.partial === true ? "·partial" : ""}: ${markerInner(items)} ──`;
}

function markerInner(items: readonly { anchor: string; p?: number }[]): string {
  return items.map((item) => `${item.anchor}${item.p === undefined ? "" : ` (${item.p.toFixed(2)})`}`).join(", ");
}

// ───────── merged-message marker (memory-predict plan §5.3; C-J16 gate) ─────────

export interface MarkerPart {
  /** String, not `InjectLayer`: a merged message may carry the future "P"
   *  layer before contracts.ts declares it (C-J16 proves the channel with a
   *  synthetic shape; P1 types it properly). */
  readonly layer: string;
  readonly items: readonly { anchor: string; p?: number }[];
  readonly partial?: boolean;
}

/** The merged-message marker, plan §5.3: `── mem P: … │ U: … ──` — one
 *  segment per `details.parts` layer, joined with ` │ `; item formatting
 *  identical to formatInjectMarker. Empty parts ⇒ the bare frame. */
export function formatInjectMarkerParts(parts: readonly MarkerPart[]): string {
  const segments = parts.map(
    (part) => `${part.layer}${part.partial === true ? "·partial" : ""}: ${markerInner(part.items)}`,
  );
  return `── mem ${segments.join(" │ ")} ──`;
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

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mmdd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m === null ? iso : `${m[2]}-${m[3]}`;
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
      return `jev on · ${info.model ?? ""} — 记忆召回、打标、整理已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭`;
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

function reportLine(label: string, content: string): string[] {
  return [`${label.padEnd(8, " ")} ${content}`];
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
  if (view.proxy !== undefined) lines.push(`proxy    ${view.proxy}`);
  lines.push(
    `usage    ${view.usage.calls} calls · $${view.usage.costUsd.toFixed(4)} / $${view.usage.maxCostUsd.toFixed(2)} · per activation (/reload resets)`,
  );
  const layerCounts = (["U", "A", "E", "B", "P"] as const)
    .map((layer) =>
      (view.segment.injectedByLayer[layer] ?? 0) > 0 ? `${layer}${view.segment.injectedByLayer[layer]}` : undefined,
    )
    .filter((part): part is string => part !== undefined)
    .join(" ");
  lines.push(
    `segment  injected ${view.segment.injectedTotal}${layerCounts === "" ? "" : ` (${layerCounts})`} · cap ${view.segment.injectedTotal}/${SEGMENT_MAX_INJECTED}`,
  );
  const reviewParts: string[] = [];
  if (view.review.lastRunAt !== undefined) reviewParts.push(`last ${view.review.lastRunAt}`);
  reviewParts.push(`${view.review.open} open → /mem review`);
  lines.push(`review   ${reviewParts.join(" · ")}`);
  if (view.predict !== undefined) lines.push(`predict  rules ${view.predict.rules}`);
  return lines.join("\n");
}

// ───────────────────────────── predict stats line (memory-predict plan §9.4 P2) ─────────────────────────────

/** Inputs of the extended `/mem jev` predict line (wire.ts's report override
 *  builds this from its closure counters + the process-level day ledger).
 *  `formatJevReport`'s own `view.predict` stays the P1 rules-only shape —
 *  `JevReportView` is a contracts.ts type and the view path is pinned
 *  byte-for-byte; the P2 slice lives only on the live report path. */
export interface PredictStatsLineInput {
  readonly rules: number;
  readonly model: number;
  readonly timely: number;
  readonly cached: number;
  readonly spentUsd: number;
  readonly maxUsdPerDay: number;
  readonly breakerOpen: boolean;
}

/** §9.4 example, verbatim shape:
 *  `predict  rules 412 · model 23 (timely 2, cached 15) · $0.0180/0.14 est today · breaker closed`. */
export function formatPredictStatsLine(input: PredictStatsLineInput): string {
  const breaker = input.breakerOpen ? "open" : "closed";
  return `predict  rules ${input.rules} · model ${input.model} (timely ${input.timely}, cached ${input.cached}) · $${input.spentUsd.toFixed(4)}/${input.maxUsdPerDay} est today · breaker ${breaker}`;
}
