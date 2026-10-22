import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { isFeishuInvocation } from "../web-hub/agent/command-capture.js";
import { isValidXsSessionId } from "../config/settings.js";
import type { XsReplyLedger } from "../fabric/xs/reply-ledger.js";
import type { SessionFence } from "../fabric/xs/fence.js";
import type { XsMembership, XsBlockEntry, XsJoinResult, XsLeaveResult } from "../fabric/xs/membership.js";
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
const FEISHU_REFUSED_SUBS = new Set(["join", "leave", "receive", "block", "unblock", "fence"]);
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
            ...channelStatusLines(membership, deps),
            ...view.lines,
          ];
          refreshChannels();
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
