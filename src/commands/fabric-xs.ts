import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { isFeishuInvocation, isWebInvocation } from "./capture.js";
import { isValidXsSessionId } from "../fabric/xs/receive.js";
import type { XsReplyLedger } from "../fabric/xs/reply-ledger.js";
import type { SessionFence } from "../fabric/xs/fence.js";
import type { XsMembership, XsBlockEntry, XsJoinResult, XsLeaveResult } from "../fabric/xs/membership.js";
import type {
  XsAliasAutoSkipReason,
  XsAliasBridgePort,
  XsAliasBridgePortV2,
  XsAliasBridgeResult,
  XsAliasCacheEntry,
  XsAliasCachePort,
} from "../fabric/xs/types-alias.js";
import type { XsAliasMarkDecided } from "../fabric/xs/alias-decided.js";
import {
  XS_ALIAS_TAKE_TOKEN_RE,
  formatTakeConfirmLine,
  normalizeAlias,
  type XsAliasRejectReason,
} from "../web-hub/protocol/xs-alias.js";
import { XS_DEFAULT_CHANNEL, XS_MAX_CHANNELS, channelSet, displayChannel } from "../fabric/xs/channel.js";

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
 *
 * Channel-plan §2.2/§6.3 (CH3): `join #a #b` / `leave #a` are incremental channel edits (echo the
 * resulting set; warn when still in `#default` alongside named channels); `channels` lists the
 * local pref/effective/suspended sets plus the hub's channel names + member counts (Q7,
 * `op:"channels"`); `status` gains a `channels …` line. Argument completion reads ONLY a local
 * cache (m5 — S-own completers are pure): local pref ∪ directory rows' channels ∪ the last
 * `channels` result, refreshed by `/fabric channels`, `/fabric status` and a successful
 * join/leave (non-blocking). Feishu stays hard-refused for join/leave; agents have no path.
 */

/** Mutating subcommands the Feishu hard gate refuses (§5.3 table's mutation rows). */
const FEISHU_REFUSED_SUBS = new Set(["join", "leave", "receive", "block", "unblock", "fence", "alias"]);
/** Fixed refusal text — identical for every refused row, independent of any policy. */
const FEISHU_REFUSAL = "飞书入口不能修改跨会话加入状态，请在终端或 web 执行";

const USAGE = [
  "/fabric status — 成员状态、接收策略、完整 sessionId、限额与栅栏",
  "/fabric join · /fabric leave — 加入 / 退出默认频道 #default（epoch +1）",
  "/fabric join #a #b · /fabric leave #a — 增量加入 / 离开命名频道（最多 4 个；leave #default 才与默认频道隔离）",
  "/fabric channels — 本地频道集合与 hub 上的频道名和人数",
  "/fabric receive off|deliver|wake|replies — 会话级接收策略覆盖",
  "/fabric replies — 回复凭证、状态与截止时间",
  "/fabric block <ref|name|sessionId> — 唯一解析后屏蔽（上限 64）",
  "/fabric blocks · /fabric unblock <序号|完整id|前缀≥8|名字> — 离线查看 / 解除",
  "/fabric fence reset — 清除 stuck 栅栏窗口（仅本地）",
  "/fabric alias [<名>|--clear] — 查看 / 设置 / 清除本会话别名；/fabric alias <名> --take 抢占离线持有者的别名（需确认）",
].join("\n");

const SUBS = [
  "replies",
  "status",
  "channels",
  "blocks",
  "join",
  "leave",
  "receive",
  "block",
  "unblock",
  "fence",
  "alias",
] as const;

/** §2.2 echo: the resulting set mixes `#default` with named channels ⇒ remind how to isolate. */
const DEFAULT_MIX_HINT = "仍在 #default（与所有默认频道会话互通）；如需隔离：/fabric leave #default";
const CHANNELS_DISABLED = "频道功能未启用（fabric.crossSession.channels.enabled=false）";

const RECEIVE_MODES = [
  { mode: "off", description: "拒收所有消息" },
  { mode: "deliver", description: "只送达，不唤醒" },
  { mode: "wake", description: "送达并可被唤醒（默认）" },
  { mode: "replies", description: "只收本会话所发请求的回复，拒收其他" },
] as const;

/** `/fabric block`'s hub resolve outcome (X2 wires the port; `resolve` absent ⇒ offline mode). */
export type XsBlockResolve =
  | { ok: true; sessionId: string; name?: string }
  | { ok: false; kind: "no_target" | "ambiguous" | "offline" | "error"; candidates?: { ref: string; name?: string }[] };

/** Channel-plan §6.3: one `op:"channels"` listing (Q7: names + member counts only). */
export type FabricXsChannelsListing =
  { ok: true; channels: readonly { name: string; members: number; joined: boolean }[] } | { ok: false; reason: string };

/** Channel-plan §6.3: effective broadcast settings shown by `/fabric status` (no usage — hub has no usage port). */
export interface FabricXsBroadcastView {
  outPerHour: number;
  wakeOutPerHour: number;
  wakeMaxRecipients: number;
}

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
  /** I1: a local `/fabric fence reset` also clears the scheduled-message dispatcher's own fence/ui-prompt blockers. */
  afterFenceReset?(): void;
  /** Channel-plan §6.3 (CHW wires the sender's `channels()`): one hub `op:"channels"` round trip. */
  channels?(): Promise<FabricXsChannelsListing>;
  /** Channel-plan §2.3: does the current hub link advertise `xs.channel.v1`? `undefined` ⇒ unknown/offline (`n/a`). */
  hubChannelCap?(): boolean | undefined;
  /** Channel-plan §6.3 (m5): channel names seen in the directory cache rows — synchronous, cache-only. */
  directoryChannels?(): readonly string[];
  /** Channel-plan §6.3: effective broadcast config (absent ⇒ no broadcast line). */
  broadcast?(): FabricXsBroadcastView | undefined;
  /** Channel-plan §2.4: `channels.autoJoin` was configured but every entry was invalid. */
  autoJoinInvalid?(): boolean;
  /**
   * Alias-plan §7 (AL4; ALW wires it): the alias ports + local settings. `undefined` ⇒ not wired (no status line,
   * `/fabric alias` reports "not enabled"). `bridge.supported`/`cache.usable` false ⇒ local refusal, nothing sent.
   */
  alias?(): FabricXsAliasPort | undefined;
}

/** Alias-plan §4/§7: what `/fabric alias` needs. Hub IO goes ONLY through `bridge` (never the connection directly). */
export interface FabricXsAliasPort {
  /** `fabric.crossSession.alias.enabled` (local). */
  localEnabled: boolean;
  bridge?: XsAliasBridgePort & Partial<Pick<XsAliasBridgePortV2, "forcePreview">>;
  cache?: Omit<XsAliasCachePort, "current"> & {
    current(): (XsAliasCacheEntry & { origin?: "auto" }) | undefined;
  };
  /** AFW: CURRENT hub caps include xs.alias.v2 (not merely local support). */
  hubAliasV2?(): boolean;
  /** Frozen setting; absent/false keeps the old status bytes. */
  autoFromCwd?: boolean;
  decided?(): boolean;
  markDecided?: XsAliasMarkDecided;
  /** AFW forwards the auto engine's cached reason; read-only, never triggers an auto attempt. */
  autoSkipReason?(): XsAliasAutoSkipReason | undefined;
  /** Display-only parameters for the status line (lease days / cooling minutes). */
  leaseDays?: number;
  coolMin?: number;
  /** Completion hints (cwd tail, session name prefix …) — raw strings, normalized + filtered here. Synchronous, no I/O. */
  suggestions?(): readonly string[];
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

function channelList(names: readonly string[]): string {
  return names.length === 0 ? "-" : names.map(displayChannel).join(" ");
}

function safe<T>(read: (() => T) | undefined): T | undefined {
  if (read === undefined) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** §2.2 refusal text shared by join/leave (whole-call refusals, nothing changed). */
function refusalText(result: Exclude<XsJoinResult | XsLeaveResult, { ok: true }>): string | undefined {
  switch (result.reason) {
    case "channels_disabled":
      return CHANNELS_DISABLED;
    case "invalid":
      return `频道名非法：${result.names.join(" ")}（小写 ASCII 字母/数字/_/-，最长 32，可带 #）；未做任何修改。`;
    case "reserved":
      return `频道名为保留名：${result.names.join(" ")}；未做任何修改。`;
    case "too_many":
      return `合并后超过 ${result.max} 个频道；未做任何修改。`;
    default:
      return undefined;
  }
}

export function createFabricXsCommand(deps: FabricXsCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const now = deps.now ?? (() => Date.now());
  /** m5: the last hub `op:"channels"` names — the ONLY network-derived completion source, refreshed by commands only. */
  let hubChannelNames: readonly string[] = [];
  // Display/persistence provenance only: the hub token owns the actual execution mode.
  // Per command/activation, FIFO <=32, no globals or timers. Unknown (e.g. reload) tokens use "take".
  const forceTokens = new Map<string, string>();
  const fetchChannels = async (): Promise<FabricXsChannelsListing | undefined> => {
    if (deps.channels === undefined) return undefined;
    let listing: FabricXsChannelsListing;
    try {
      listing = await deps.channels();
    } catch {
      listing = { ok: false, reason: "error" };
    }
    if (listing.ok) hubChannelNames = channelSet(listing.channels.map((c) => c.name));
    return listing;
  };
  /** Non-blocking refresh (status / join / leave): never awaited, never throws. */
  const refreshChannels = (): void => {
    void fetchChannels().catch(() => undefined);
  };
  const channelCandidates = (membership: XsMembership | undefined): string[] =>
    channelSet([...(membership?.pref() ?? []), ...(safe(deps.directoryChannels) ?? []), ...hubChannelNames]);
  return {
    description:
      "fabric 跨会话通信：/fabric status 查看成员状态；join/leave/receive 管理加入；block/blocks/unblock 管理屏蔽；fence reset 清除 stuck 栅栏（飞书入口不可修改成员）。",
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const raw = argumentPrefix.trimStart();
        const m = /^(\S*)(\s+)?(.*)$/s.exec(raw);
        const first = m?.[1] ?? "";
        if (m === null || m[2] === undefined) {
          // First token not finished yet → complete the subcommand.
          return SUBS.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
        }
        const rest = m[3] ?? "";
        if (first === "join" || first === "leave") {
          // §6.3 (m5): pure — local pref ∪ directory rows ∪ the cached hub listing; no I/O.
          const parts = rest.split(/\s+/);
          const last = parts.pop() ?? "";
          const typed = parts.filter((p) => p !== "");
          const membership = deps.membership();
          const pref = new Set(membership?.pref() ?? []);
          const pool = first === "join" ? channelCandidates(membership).filter((c) => !pref.has(c)) : [...pref];
          const needle = last.startsWith("#") ? last.slice(1) : last;
          const already = new Set(typed.map((t) => (t.startsWith("#") ? t.slice(1) : t).toLowerCase()));
          return pool
            .filter((c) => c.startsWith(needle.toLowerCase()) && !already.has(c))
            .map((c) => ({
              value: [first, ...typed, displayChannel(c)].join(" "),
              label: displayChannel(c),
              ...(first === "leave" && c === XS_DEFAULT_CHANNEL ? { description: "离开后不再与默认频道会话互通" } : {}),
            }));
        }
        if (first === "alias") {
          const parts = rest.split(/\s+/);
          if (parts.length === 1) {
            const port = safe(deps.alias);
            const hints: string[] = [];
            for (const raw of safe(port?.suggestions?.bind(port)) ?? []) {
              const n = normalizeAlias(raw);
              if (n.ok && !hints.includes(n.alias)) hints.push(n.alias);
            }
            const pool = ["--clear", ...hints.slice(0, 8)];
            return pool
              .filter((c) => c.startsWith(rest))
              .map((c) => ({
                value: `alias ${c}`,
                label: c,
                ...(c === "--clear" ? { description: "清除本会话别名" } : {}),
              }));
          }
          const last = parts[parts.length - 1] ?? "";
          if (parts.length === 2 && parts[0] !== "--clear") {
            const flags = [
              { label: "--take", description: "抢占离线持有者的别名（需确认）" },
              ...(safe(safe(deps.alias)?.hubAliasV2) === true && normalizeAlias(parts[0]).ok
                ? [{ label: "--force", description: "强制抢占（持有者在线也可，需确认）" }]
                : []),
            ];
            return flags
              .filter((f) => f.label.startsWith(last) && f.label !== last)
              .map((f) => ({
                value: `alias ${parts[0]} ${f.label}`,
                ...f,
              }));
          }
          return [];
        }
        if (/\s/.test(rest)) return [];
        if (first === "receive") {
          const replyOn = deps.membership()?.replyEnabled ?? true;
          return RECEIVE_MODES.filter((r) => r.mode.startsWith(rest)).map((r) => ({
            value: `receive ${r.mode}`,
            label: r.mode,
            description: r.mode === "replies" && !replyOn ? `${r.description}（需开启回复功能）` : r.description,
          }));
        }
        if (first === "fence") {
          return "reset".startsWith(rest)
            ? [{ value: "fence reset", label: "reset", description: "清除 stuck 栅栏窗口" }]
            : [];
        }
        if (first === "unblock") {
          const entries = deps.membership()?.blockedSnapshot() ?? [];
          return entries
            .filter((e) => e.sessionId.startsWith(rest) || (e.nameSnapshot ?? "").startsWith(rest))
            .map((e) => ({
              value: `unblock ${e.sessionId}`,
              label: e.nameSnapshot ?? e.sessionId.slice(0, 8),
              description: e.sessionId,
            }));
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
        notify(
          ctx,
          USAGE +
            (safe(safe(deps.alias)?.hubAliasV2) === true
              ? "\n/fabric alias <名> --force — 强制抢占（持有者在线也可，需确认）"
              : ""),
          "warning",
        );
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
            ...channelStatusLines(membership, deps),
            ...aliasStatusLines(deps),
            ...view.lines,
          ];
          refreshChannels();
          refreshAlias(deps);
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
        case "channels": {
          const listing = await fetchChannels();
          notify(ctx, renderChannels(membership, deps, listing));
          return;
        }
        case "join": {
          const args = tokens.slice(1);
          const result = membership.join(args);
          if (!result.ok) {
            const refusal = refusalText(result);
            notify(
              ctx,
              refusal ?? `已经加入（already joined）。${currentSetText(membership)}`,
              refusal ? "warning" : "info",
            );
            return;
          }
          deps.onPolicyChange?.();
          refreshChannels();
          notify(
            ctx,
            [`已加入（epoch ${result.epoch}）。${currentSetText(membership)}`, ...mixHint(membership)].join("\n"),
          );
          return;
        }
        case "leave": {
          const args = tokens.slice(1);
          const result = membership.leave(args);
          if (!result.ok) {
            const refusal = refusalText(result);
            notify(
              ctx,
              refusal ??
                (args.length === 0
                  ? "尚未加入（not joined）。"
                  : `不在这些频道中（not joined）。${currentSetText(membership)}`),
              refusal ? "warning" : "info",
            );
            return;
          }
          refreshChannels();
          notify(
            ctx,
            args.length === 0
              ? `已退出（epoch ${result.epoch}）；屏蔽列表保留。`
              : [`已离开（epoch ${result.epoch}）。${currentSetText(membership)}`, ...mixHint(membership)].join("\n"),
          );
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
        case "alias":
          await runAlias(ctx, tokens.slice(1), deps, forceTokens);
          return;
        case "fence": {
          if (tokens[1] !== "reset") {
            notify(ctx, "用法：/fabric fence reset", "warning");
            return;
          }
          fence.reset();
          deps.afterFenceReset?.();
          deps.onPolicyChange?.();
          notify(ctx, "栅栏窗口已清除（仅本地；stuck 计时重置）。");
          return;
        }
      }
    },
  };
}

/** §2.2 echo: the resulting effective set (+ suspended names when channels are disabled). */
function currentSetText(membership: XsMembership): string {
  const eff = membership.effective();
  const suspended = membership.suspended();
  return `当前频道：${eff.length === 0 ? "（未加入任何频道）" : channelList(eff)}${
    suspended.length > 0 ? ` · 挂起 ${channelList(suspended)}（channels.enabled=false）` : ""
  }`;
}

function mixHint(membership: XsMembership): string[] {
  const eff = membership.effective();
  return eff.includes(XS_DEFAULT_CHANNEL) && eff.length > 1 ? [DEFAULT_MIX_HINT] : [];
}

/**
 * §6.3 status line(s) (English tokens): `channels #default #team (2/4) · hub-cap on · suspended -`,
 * plus the hub-cap-off link note (§3.4), the autoJoin-invalid note (§2.4) and the effective
 * broadcast config (`usage n/a` — the hub has no usage port, 评审 #16).
 */
function channelStatusLines(membership: XsMembership, deps: FabricXsCommandDeps): string[] {
  const eff = membership.effective();
  const suspended = membership.suspended();
  const hubCap = safe(deps.hubChannelCap);
  let line = `channels ${channelList(eff)} (${eff.length}/${XS_MAX_CHANNELS}) · hub-cap ${
    hubCap === undefined ? "n/a" : hubCap ? "on" : "off"
  } · suspended ${channelList(suspended)}${suspended.length > 0 ? " (channels.enabled=false)" : ""}`;
  if (hubCap === false && eff.some((c) => c !== XS_DEFAULT_CHANNEL)) {
    const link = membership.link(false);
    line +=
      link.length === 0
        ? " · link - (hub-cap off: not joined on this hub; /webhub restart)"
        : ` · link ${channelList(link)} (hub-cap off: named channels inactive; /webhub restart)`;
  }
  const lines = [line];
  if (safe(deps.autoJoinInvalid) === true)
    lines.push("autoJoin: every configured channel is invalid — nothing auto-joined");
  const broadcast = membership.channelsEnabled ? safe(deps.broadcast) : undefined;
  if (broadcast !== undefined) {
    lines.push(
      `broadcast ≤${broadcast.outPerHour}/h · wake ≤${broadcast.wakeOutPerHour}/h ≤${broadcast.wakeMaxRecipients} rcpt · usage n/a`,
    );
  }
  return lines;
}

/** §6.3 `/fabric channels`: local pref/effective/suspended + the hub listing (Q7). */
function renderChannels(
  membership: XsMembership,
  deps: FabricXsCommandDeps,
  listing: FabricXsChannelsListing | undefined,
): string {
  const lines = [
    `local: pref ${channelList(membership.pref())} · effective ${channelList(membership.effective())} · suspended ${channelList(membership.suspended())}${
      membership.suspended().length > 0 ? " (channels.enabled=false)" : ""
    }`,
    ...channelStatusLines(membership, deps).slice(0, 1),
  ];
  if (listing === undefined) {
    lines.push("hub: n/a (频道列表不可用：未连接 hub 或频道功能未启用)");
  } else if (!listing.ok) {
    lines.push(`hub: unavailable (${listing.reason})`);
  } else if (listing.channels.length === 0) {
    lines.push("hub: no channels");
  } else {
    lines.push(`hub channels (${listing.channels.length}):`);
    for (const c of listing.channels) {
      lines.push(
        `  ${displayChannel(c.name)} · ${c.members} member${c.members === 1 ? "" : "s"}${c.joined ? " · joined" : ""}`,
      );
    }
  }
  return lines.join("\n");
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

// ----------------------------------------------------------------- alias (alias-plan §3.5/§7, AL4)

const ALIAS_REASON_TEXT: Record<XsAliasRejectReason, string> = {
  invalid:
    "别名含不允许的字符或形状（只允许 ASCII 字母数字/_/-、汉字、假名、韩文音节；至少含一个字母或汉字；不能以 _ - ー 开头）",
  too_long: "别名过长（最多 16 个字形簇且 ≤48 字节）",
  id_like: "别名不能像 sessionId（8 位以上十六进制/连字符）",
  reserved: "别名是保留词",
};

/** Hub error → fixed user text. `code` may carry a `{detail}` suffix; otherwise `reason` is the detail. */
function aliasErrorText(code: string, reason: string | undefined, forceAlias?: string): string {
  const m = /^([A-Z_]+)(?:\{([^}]*)\})?$/.exec(code);
  const base = m?.[1] ?? code;
  const detail = m?.[2] ?? reason;
  const forceHint = forceAlias === undefined ? "" : ` 可用 /fabric alias ${forceAlias} --force 强制抢占（需确认）`;
  switch (base) {
    case "E_XS_ALIAS_INVALID":
      return ALIAS_REASON_TEXT[
        (detail as XsAliasRejectReason) in ALIAS_REASON_TEXT ? (detail as XsAliasRejectReason) : "invalid"
      ];
    case "E_XS_ALIAS_TAKEN":
      return detail === "confusable" ? "别名与已有别名过于相似，未设置。" : `别名已被占用，未设置。${forceHint}`;
    case "E_XS_ALIAS_TAKE":
      return detail === "online"
        ? `持有者仍在线，不能抢占。${forceHint}`
        : detail === "recent"
          ? `持有者离线不足 10 分钟，暂不能抢占。${forceHint}`
          : detail === "stale"
            ? "状态已变化或确认已失效，请重新预览：/fabric alias <名> --take"
            : detail === "unnotifiable"
              ? "持有会话在线但无法实时通知（版本较旧或未启用跨会话），不能强制抢占；请待其离线 ≥10 分钟后用 --take。"
              : "该别名当前没有可抢占的持有者。";
    case "E_XS_ALIAS_FULL":
      return "hub 别名表已满，未设置。";
    case "E_XS_ALIAS_BUSY":
      return detail === "tokens" ? "抢占确认过多，请稍后再试。" : "别名服务繁忙，请稍后再试。";
    case "E_XS_ALIAS_UNKNOWN":
      return "别名写入结果未知（可能已生效），请稍后用 /fabric alias 查看，不要立刻重试。";
    case "E_XS_ALIAS_UNAVAILABLE":
      return "hub 别名服务暂不可用（需 /webhub restart）。";
    default:
      return `别名操作失败：${base}${detail !== undefined && detail !== "" ? `（${detail}）` : ""}`;
  }
}

function dhm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

/** cwdLabel is untrusted plain text: drop control chars (so it can never forge a line), cap 120. */
function cleanCwdLabel(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/\p{C}/gu, "") : "";
  return Array.from(s).slice(0, 120).join("");
}

function aliasPort(deps: FabricXsCommandDeps): FabricXsAliasPort | undefined {
  return safe(deps.alias);
}

/** `undefined` ⇒ usable; otherwise the local refusal text (nothing goes to the hub). */
function aliasUnavailable(port: FabricXsAliasPort | undefined): string | undefined {
  if (port === undefined || !port.localEnabled) return "别名功能未启用（fabric.crossSession.alias.enabled=false）";
  if (port.bridge === undefined || !port.bridge.supported || port.cache?.usable === false) {
    return "hub 不支持别名或别名服务降级，需 /webhub restart";
  }
  return undefined;
}

function aliasStatusLines(deps: FabricXsCommandDeps): string[] {
  const port = aliasPort(deps);
  if (port === undefined) return [];
  if (!port.localEnabled) return ["alias n/a (alias.enabled=false)"];
  if (aliasUnavailable(port) !== undefined) return ["alias n/a (hub-cap off)"];
  const e = safe(() => port.cache?.current());
  // Preserve v1 / autoFromCwd=false display byte-for-byte.
  const auto = port.autoFromCwd === true && safe(port.hubAliasV2) === true;
  if (e?.alias !== undefined) {
    return [
      `alias @${e.alias} held${auto && e.origin === "auto" ? " (auto)" : ""} · lease ${port.leaseDays ?? 7}d · cool ${port.coolMin ?? 10}m`,
    ];
  }
  const line = e?.lostAt !== undefined ? `alias - (lost: ${e.lostReason ?? "taken"})` : "alias -";
  const skip = auto ? (safe(port.decided) === true ? "decided" : safe(port.autoSkipReason)) : undefined;
  return [line + (skip === undefined ? "" : ` · auto skip:${skip}`)];
}

/** Non-blocking reconcile after `/fabric status` / `/fabric alias` (never awaited, never throws). */
function refreshAlias(deps: FabricXsCommandDeps): void {
  const port = aliasPort(deps);
  if (port?.cache === undefined || aliasUnavailable(port) !== undefined) return;
  try {
    void port.cache.reconcile().catch(() => undefined);
  } catch {
    /* best effort */
  }
}

/** Writing the decided mark is best effort: a failing store must never block the write request itself. */
function markDecidedSafe(port: FabricXsAliasPort | undefined, via: Parameters<XsAliasMarkDecided>[0]): void {
  try {
    port?.markDecided?.(via);
  } catch {
    /* the mark is a hint; the human's request still goes out */
  }
}

async function bridgeCall(run: () => Promise<XsAliasBridgeResult>): Promise<XsAliasBridgeResult> {
  try {
    return await run();
  } catch {
    return { ok: false, code: "E_XS_ALIAS_UNAVAILABLE" };
  }
}

function stateText(res: object): string {
  const r = res as { alias?: unknown; state?: unknown; lost?: { alias?: unknown; reason?: unknown } };
  const lost =
    r.lost !== undefined && typeof r.lost.alias === "string"
      ? `（原别名「${r.lost.alias}」已${r.lost.reason === "expired" ? "过期被他人认领" : "被抢占"}）`
      : "";
  return typeof r.alias === "string" && r.state === "held" ? `alias @${r.alias} held${lost}` : `alias -${lost}`;
}

async function runAlias(
  ctx: ExtensionCommandContext,
  args: readonly string[],
  deps: FabricXsCommandDeps,
  forceTokens: Map<string, string>,
): Promise<void> {
  const port = aliasPort(deps);
  const hasForceInput = args.some((a) => a === "--force" || a.startsWith("--force="));
  const usage =
    "用法：/fabric alias [<名>|--clear] · /fabric alias <名> --take" +
    (safe(port?.hubAliasV2) === true || hasForceInput ? " · /fabric alias <名> --force" : "");
  const flags = args.filter((a) => a.startsWith("--"));
  const words = args.filter((a) => !a.startsWith("--"));
  const clear = flags.includes("--clear");
  const force = flags.includes("--force");
  const takeFlag = flags.find((f) => f === "--take" || f.startsWith("--take="));
  const unknownFlag = flags.some(
    (f) => f !== "--clear" && f !== "--force" && f !== "--take" && !f.startsWith("--take="),
  );
  // Validate the WHOLE call before marking, previewing or any other bridge request.
  if (
    unknownFlag ||
    flags.length > 2 ||
    (force && flags.length !== 1) ||
    words.length > 1 ||
    (clear && (words.length !== 0 || takeFlag !== undefined)) ||
    ((force || takeFlag !== undefined) && words.length !== 1)
  ) {
    // Without the new flag, preserve the legacy unavailable-before-usage diagnostic.
    notify(ctx, (!hasForceInput ? aliasUnavailable(port) : undefined) ?? usage, "warning");
    return;
  }
  const execute = takeFlag?.startsWith("--take=") === true;
  const token = execute ? takeFlag!.slice("--take=".length) : undefined;
  const n = words.length === 1 ? normalizeAlias(words[0]) : undefined;
  const forceToken = token !== undefined && n?.ok && forceTokens.get(token) === n.alias;
  // D6: even a locally invalid alias, bad token or failed/offline write is a human decision.
  // Syntax errors, reads, previews and disabled alias mode are NOT writes.
  if (port?.localEnabled && (clear || execute || (words.length === 1 && !force && takeFlag === undefined))) {
    markDecidedSafe(port, clear ? "clear" : execute ? (forceToken ? "force" : "take") : "set");
  }
  if (token !== undefined) forceTokens.delete(token);

  const refusal = aliasUnavailable(port);
  const bridge = port?.bridge;
  if (refusal !== undefined || bridge === undefined) {
    notify(ctx, refusal ?? "hub 不支持别名或别名服务降级，需 /webhub restart", "warning");
    return;
  }
  const v2 = safe(port?.hubAliasV2) === true;
  if (force && (!v2 || bridge.forcePreview === undefined)) {
    notify(ctx, "hub 不支持强制抢占，需 /webhub restart", "warning");
    return;
  }
  const errorText = (r: Extract<XsAliasBridgeResult, { ok: false }>) =>
    aliasErrorText(r.code, r.reason, v2 && n?.ok ? n.alias : undefined);

  if (!clear && words.length === 0) {
    const r = await bridgeCall(() => bridge.get());
    if (!r.ok) return notify(ctx, errorText(r), "warning");
    notify(ctx, stateText(r.res));
    refreshAlias(deps);
    return;
  }
  if (clear) {
    const r = await bridgeCall(() => bridge.clear());
    if (!r.ok) return notify(ctx, errorText(r), "warning");
    notify(
      ctx,
      "已清除本会话别名（10 分钟内只有本会话能收回）。" +
        (v2 && port?.autoFromCwd === true ? "已关闭本会话的目录名自动别名。" : ""),
    );
    refreshAlias(deps);
    return;
  }
  if (n === undefined || !n.ok) {
    notify(ctx, `${ALIAS_REASON_TEXT[n?.reason ?? "invalid"]}。`, "warning");
    return;
  }
  if (takeFlag === undefined && !force) {
    const r = await bridgeCall(() => bridge.set(n.alias));
    if (!r.ok) return notify(ctx, errorText(r), "warning");
    notify(ctx, `别名已设置：${stateText(r.res)}`);
    refreshAlias(deps);
    return;
  }
  if (execute) {
    if (token === undefined || !XS_ALIAS_TAKE_TOKEN_RE.test(token)) {
      notify(ctx, "抢占确认串格式无效，请重新预览：/fabric alias <名> --take", "warning");
      return;
    }
    const r = await bridgeCall(() => bridge.take(n.alias, token));
    if (!r.ok) return notify(ctx, errorText(r), "warning");
    notify(ctx, `已抢占别名：${stateText(r.res)}`);
    refreshAlias(deps);
    return;
  }

  // --force is PREVIEW ONLY. Both modes execute through the existing --take=<token> path.
  const p = await bridgeCall(() => (force ? bridge.forcePreview!(n.alias) : bridge.takePreview(n.alias)));
  if (!p.ok) return notify(ctx, errorText(p), "warning");
  const take = (
    p.res as { take?: { cwdLabel?: unknown; offlineForS?: unknown; token?: unknown; online?: unknown; auto?: unknown } }
  ).take;
  if (take === undefined || typeof take.token !== "string" || !XS_ALIAS_TAKE_TOKEN_RE.test(take.token)) {
    notify(ctx, "别名服务返回了无效的抢占预览。", "warning");
    return;
  }
  const previewToken = take.token;
  if (force) {
    if (forceTokens.size >= 32) forceTokens.delete(forceTokens.keys().next().value!);
    forceTokens.set(previewToken, n.alias);
  }
  const offline = typeof take.offlineForS === "number" ? dhm(take.offlineForS) : "未知时长";
  const holder = `${cleanCwdLabel(take.cwdLabel) || "(未知目录)"}${v2 && take.auto === true ? "（自动认领）" : ""}`;
  const detail = force
    ? `持有会话：${holder}，${take.online === true ? "当前在线" : `已离线 ${offline}`}。对方会立即收到「别名被强制抢占」提示；此后发给「${n.alias}」的消息将改投本会话（已发出的仍送达对方）。`
    : `持有会话：${holder}，已离线 ${offline}。抢占后对方回来会失去此别名并收到提示。`;
  const title = `${force ? "强制抢占" : "抢占"}别名「${n.alias}」？`;

  if (ctx.mode === "tui" && !isWebInvocation(ctx)) {
    let ok = false;
    try {
      ok = (await ctx.ui.confirm(title, detail)) === true;
    } catch {
      /* cancellation */
    }
    if (!ok) {
      notify(ctx, "已取消抢占。");
      return;
    }
    markDecidedSafe(port, force ? "force" : "take");
    forceTokens.delete(previewToken);
    const r = await bridgeCall(() => bridge.take(n.alias, previewToken));
    if (!r.ok) return notify(ctx, errorText(r), "warning");
    notify(ctx, `已抢占别名：${stateText(r.res)}`);
    refreshAlias(deps);
    return;
  }
  // Fixed last line: parseTakeConfirm and the web parser remain unchanged.
  notify(ctx, [title + detail, formatTakeConfirmLine(n.alias, previewToken)].join("\n"));
}
