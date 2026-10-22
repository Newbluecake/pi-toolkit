import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { isFeishuInvocation } from "../web-hub/agent/command-capture.js";
import { isValidXsSessionId } from "../config/settings.js";
import type { XsReplyLedger } from "../fabric/xs/reply-ledger.js";
import type { SessionFence } from "../fabric/xs/fence.js";
import type { XsMembership, XsBlockEntry } from "../fabric/xs/membership.js";

/**
 * fabric phase-2 X4 (phase2-plan §5.3/§10.3, review #9/XI13 — superseded for web by the
 * 2026-10-22 user ruling, see the appended section of phase2-plan.md): the `/fabric` command —
 * the ONLY human surface for session-level cross-session membership. Rules:
 *
 *  1. **Feishu-only hard gate, FIRST line of the handler** (2026-10-22 ruling): web (loopback
 *     browser + LAN-logged-in web) may now execute every subcommand — gated by
 *     `webCommandPolicy.fabric` (default allow) at the command-op policy layer, NOT here. The
 *     only hard refusal left is the Feishu source (`isFeishuInvocation`): a Feishu-marked
 *     invocation cannot join/leave/receive/block/unblock/fence reset. Local TUI, local RPC and
 *     web invocations all pass; the Feishu marker is derived from the trusted hub-internal
 *     origin (admission never forwards Feishu `command` frames today — this is the
 *     defense-in-depth layer that survives any future widening).
 *  2. **Offline surfaces** (§5.3/#14): `/fabric blocks` and `/fabric unblock` resolve against
 *     the LOCAL persisted blocklist only — never the hub. `/fabric block` resolves via the hub
 *     when available (uniquely, else candidates and no block) and accepts a full sessionId
 *     verbatim when the target is offline.
 *
 * Assembly (XW): registers the command (main session, post-guard), wires membership/fence/
 * resolve/statusView. The module owns only command parsing + rendering + the gate.
 */

/** Mutating subcommands the Feishu hard gate refuses (§5.3 table's mutation rows). */
const FEISHU_REFUSED_SUBS = new Set(["join", "leave", "receive", "block", "unblock", "fence"]);
/** Fixed refusal text — identical for every refused row, independent of any policy. */
const FEISHU_REFUSAL = "飞书入口不能修改跨会话加入状态，请在终端或 web 执行";

const USAGE = [
  "/fabric status — 成员状态、接收策略、完整 sessionId、限额与栅栏",
  "/fabric join · /fabric leave — 加入 / 退出（epoch +1）",
  "/fabric receive off|deliver|wake|replies — 会话级接收策略覆盖",
  "/fabric replies — 回复凭证、状态与截止时间",
  "/fabric block <ref|name|sessionId> — 唯一解析后屏蔽（上限 64）",
  "/fabric blocks · /fabric unblock <序号|完整id|前缀≥8|名字> — 离线查看 / 解除",
  "/fabric fence reset — 清除 stuck 栅栏窗口（仅本地）",
].join("\n");

const SUBS = ["replies", "status", "blocks", "join", "leave", "receive", "block", "unblock", "fence"] as const;

/** `/fabric block`'s hub resolve outcome (X2 wires the port; `resolve` absent ⇒ offline mode). */
export type XsBlockResolve =
  | { ok: true; sessionId: string; name?: string }
  | { ok: false; kind: "no_target" | "ambiguous" | "offline" | "error"; candidates?: { ref: string; name?: string }[] };

export interface FabricXsStatusView {
  /** Host capability state (`unknown|observed|verified|absent`). */
  capability: string;
  /** Pre-rendered extra lines (English tokens) — counters, hub limits diff, collisions. */
  lines: readonly string[];
}

export interface FabricXsCommandDeps {
  /** `xsOn` frozen at activate. */
  enabled(): boolean;
  sessionId(): string;
  membership(): XsMembership | undefined;
  fence(): SessionFence | undefined;
  resolve?(query: string): Promise<XsBlockResolve>;
  statusView(): FabricXsStatusView;
  now?: () => number;
  replies?(): { ledger: XsReplyLedger; maxPending: number } | undefined;
  /** RXW connects to NoticeGate.flush after a human opens an admission gate. */
  onPolicyChange?(): void;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    /* best effort */
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function renderBlocks(entries: readonly XsBlockEntry[], now: () => number): string {
  if (entries.length === 0) return "屏蔽列表为空。";
  const rows = entries.map(
    (e, i) =>
      `${i + 1}. ${e.sessionId}${e.nameSnapshot !== undefined ? `  name=${e.nameSnapshot}` : ""}  ${ago(now() - e.at)} ago`,
  );
  return [`屏蔽列表（${entries.length}/64，离线）：`, ...rows].join("\n");
}

export function createFabricXsCommand(deps: FabricXsCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const now = deps.now ?? (() => Date.now());
  return {
    description:
      "fabric 跨会话通信：/fabric status 查看成员状态；join/leave/receive 管理加入；block/blocks/unblock 管理屏蔽；fence reset 清除 stuck 栅栏（飞书入口不可修改成员）。",
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const prefix = argumentPrefix.trim();
        const matches = SUBS.filter((s) => s.startsWith(prefix));
        if (matches.length > 0) {
          return matches.map((s) => ({ value: s, label: s }));
        }
        const tokens = argumentPrefix.trimStart().split(/\s+/);
        if (tokens[0] === "receive" && tokens.length <= 2) {
          const p = tokens[1] ?? "";
          return ["off", "deliver", "wake", "replies"]
            .filter((m) => m.startsWith(p))
            .map((m) => ({ value: `receive ${m}`, label: m }));
        }
        return [];
      } catch {
        return [];
      }
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
      const sub = tokens[0] ?? "status";

      // 2026-10-22 user ruling (supersedes §5.3/#9/XI13's web hard gate): web/LAN invocations
      // may mutate — the web surface is governed by `webCommandPolicy.fabric` at the command-op
      // policy layer. The ONE hard refusal left is the Feishu source: it can never mutate
      // membership, receive policy, the blocklist or the fence, whatever the policy says.
      if (FEISHU_REFUSED_SUBS.has(sub) && isFeishuInvocation(ctx)) {
        notify(ctx, FEISHU_REFUSAL, "warning");
        return;
      }

      if (!SUBS.includes(sub as (typeof SUBS)[number])) {
        notify(ctx, USAGE, "warning");
        return;
      }
      if (!deps.enabled()) {
        notify(
          ctx,
          "跨会话未启用（需 fabric.enabled + fabric.crossSession.enabled + webHub），/reload 后生效。",
          "warning",
        );
        return;
      }
      const membership = deps.membership();
      const fence = deps.fence();
      if (membership === undefined || fence === undefined) {
        notify(ctx, "fabric 跨会话尚未初始化（栈未装配）。", "warning");
        return;
      }

      switch (sub) {
        case "status":
        case undefined: {
          const view = deps.statusView();
          const allow = membership.allowFromView();
          const fenceStatus = fence.status();
          const lines = [
            `xs: ${membership.joined ? "joined" : "not joined"} · recv ${membership.receive}${
              membership.receivePref !== membership.receive ? ` (pref ${membership.receivePref})` : ""
            } · epoch ${membership.epoch}`,
            `sid: ${deps.sessionId()}（其他会话把它写入 fabric.crossSession.allowFrom 可限制来源）`,
            `allowFrom: ${allow.denyAll ? "deny-all（配置全部非法，拒收一切）" : allow.list.length === 0 ? "any joined session" : `${allow.list.length} 个会话`}`,
            `blocked: ${membership.blockedSnapshot().length}`,
            `fence: open [${fenceStatus.open.join(",") || "-"}] · stuck [${fenceStatus.stuck.join(",") || "-"}]${
              fenceStatus.oldestOpenMs !== undefined ? ` · oldest ${ago(fenceStatus.oldestOpenMs)}` : ""
            }`,
            `host cap: ${view.capability}`,
            ...view.lines,
          ];
          const replies = deps.replies?.();
          if (replies !== undefined) {
            const s = replies.ledger.stats(deps.sessionId(), now());
            lines.push(
              `replies pending ${s.pending}/${replies.maxPending} · inbox ${s.inbox} · timedOut ${s.timedOut} · late ${s.late} · rejected ${s.rejected} · owed ${s.owed} · dropped ${s.dropped} · ledger ${s.ledger.size}/${s.ledger.capacity}`,
            );
          }
          notify(ctx, lines.join("\n"));
          return;
        }
        case "replies": {
          const replies = deps.replies?.();
          if (!membership.replyEnabled || replies === undefined) {
            notify(ctx, "回复功能未启用（fabric.crossSession.reply.enabled=false）", "warning");
            return;
          }
          const rows = replies.ledger.repliesView(deps.sessionId(), now());
          notify(
            ctx,
            rows.length === 0
              ? "replies: empty"
              : rows
                  .map(
                    (r) =>
                      `${r.requestId} · ${r.replierRef} · ${r.remainingS}s · ${r.state} · owed ${r.owed ? "yes" : "no"}`,
                  )
                  .join("\n"),
          );
          return;
        }
        case "blocks":
          notify(ctx, renderBlocks(membership.blockedSnapshot(), now));
          return;
        case "join": {
          const result = membership.join();
          deps.onPolicyChange?.();
          notify(ctx, result.ok ? `已加入（epoch ${result.epoch}）。` : "已经加入（already joined）。");
          return;
        }
        case "leave": {
          const result = membership.leave();
          notify(ctx, result.ok ? `已退出（epoch ${result.epoch}）；屏蔽列表保留。` : "尚未加入（not joined）。");
          return;
        }
        case "receive": {
          const mode = tokens[1];
          if (mode !== "off" && mode !== "deliver" && mode !== "wake" && mode !== "replies") {
            notify(ctx, "用法：/fabric receive off|deliver|wake|replies", "warning");
            return;
          }
          if (mode === "replies" && !membership.replyEnabled) {
            notify(ctx, "回复功能未启用（fabric.crossSession.reply.enabled=false）", "warning");
            return;
          }
          const result = membership.setReceive(mode);
          deps.onPolicyChange?.();
          notify(ctx, `接收策略：${mode}${result.changed ? "" : "（未变化）"}。`);
          return;
        }
        case "block":
          await runBlock(ctx, tokens.slice(1).join(" "), membership, deps);
          return;
        case "unblock":
          runUnblock(ctx, tokens.slice(1).join(" "), membership);
          return;
        case "fence": {
          if (tokens[1] !== "reset") {
            notify(ctx, "用法：/fabric fence reset", "warning");
            return;
          }
          fence.reset();
          deps.onPolicyChange?.();
          notify(ctx, "栅栏窗口已清除（仅本地；stuck 计时重置）。");
          return;
        }
      }
    },
  };
}

async function runBlock(
  ctx: ExtensionCommandContext,
  arg: string,
  membership: XsMembership,
  deps: FabricXsCommandDeps,
): Promise<void> {
  const target = arg.trim();
  if (target === "") {
    notify(ctx, "用法：/fabric block <ref|name|sessionId>", "warning");
    return;
  }
  let sessionId: string | undefined;
  let nameSnapshot: string | undefined;
  if (deps.resolve !== undefined) {
    let resolved: XsBlockResolve;
    try {
      resolved = await deps.resolve(target);
    } catch {
      resolved = { ok: false, kind: "error" };
    }
    if (resolved.ok) {
      sessionId = resolved.sessionId;
      nameSnapshot = resolved.name;
    } else if (resolved.kind === "ambiguous") {
      const rows = (resolved.candidates ?? []).map((c) => `${c.ref}${c.name !== undefined ? ` (${c.name})` : ""}`);
      notify(ctx, `地址歧义，未屏蔽。候选：${rows.join(" · ") || "(无)"}`, "warning");
      return;
    }
    // no_target / offline / error ⇒ fall through to the offline full-id rule below.
  }
  if (sessionId === undefined) {
    // 目标离线（或解析不可用）时只接受完整 sessionId（§5.3/#14）。名字与 sessionId 无法结构化
    // 区分，这里用 ≥8 字符（与 resolve 前缀下限一致）作为「看起来是完整 id」的下界：短名字
    // 一律拒绝，长名字误判的代价只是屏蔽了一个不存在的 id（可随时 unblock）。
    if (!isValidXsSessionId(target) || target.length < 8) {
      notify(ctx, "目标不在线且参数不是完整 sessionId；离线屏蔽只接受完整 sessionId。", "warning");
      return;
    }
    sessionId = target;
  }
  const result = membership.block(sessionId, nameSnapshot);
  if (result.ok) {
    notify(
      ctx,
      `已屏蔽 ${result.entry.sessionId}${nameSnapshot !== undefined ? ` (${nameSnapshot})` : ""}（${result.size}/64）。`,
    );
    return;
  }
  const reason =
    result.reason === "cap" ? "屏蔽列表已满（64）" : result.reason === "duplicate" ? "已在屏蔽列表" : "非法 sessionId";
  notify(ctx, `未屏蔽：${reason}。`, "warning");
}

function runUnblock(ctx: ExtensionCommandContext, arg: string, membership: XsMembership): void {
  const selector = arg.trim();
  if (selector === "") {
    notify(ctx, "用法：/fabric unblock <序号|完整sessionId|前缀≥8|名字快照>", "warning");
    return;
  }
  const result = membership.unblock(selector);
  if (result.ok) {
    const rows = result.released.map((e) => e.sessionId);
    notify(ctx, `已解除：${rows.join(" · ")}`);
    return;
  }
  if (result.reason === "ambiguous") {
    const rows = (result.candidates ?? []).map(
      (e) => `${e.sessionId}${e.nameSnapshot !== undefined ? ` (${e.nameSnapshot})` : ""}`,
    );
    notify(ctx, `选择歧义，未解除。候选：\n${rows.join("\n")}`, "warning");
    return;
  }
  notify(ctx, "未找到匹配的屏蔽条目。", "warning");
}
