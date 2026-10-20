/** F8 composition root. Factories only: FA owns hub/caps/idle/admin transport wiring.
 * NO listener except F3. Public admin() is local-TUI ONLY; FA must never expose it to web/LAN. */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  FEISHU_API_BASES,
  FEISHU_SHUTDOWN_BUDGET_MS,
  FEISHU_OPEN_ID_RE,
  type FeishuBotHubConfig,
  type FsbInfoData,
  type FsbReqFrame,
  type FsbResFrame,
  type FeishuCapabilityName,
} from "../../protocol/feishu.js";
import type { DialogWire, DialogClosedWire } from "../../protocol/messages.js";
import type { CmdLimit } from "../cmd-limit.js";
import { isTerminalSpawnState } from "../spawn/store.js";
import type { SpawnSupervisor } from "../spawn/supervisor.js";
import { createReqDeadline } from "../req-deadline.js";
import { startFresh, createSpawnIdempotency, type FreshSpawnContext, type FreshSpawnIntent } from "../spawn/entry.js";
import { createCredentialStore, type FeishuFs, type CredentialInput } from "./credentials.js";
import { createFeishuState } from "./state.js";
import { createRegistration, refusalToFsbCode } from "./registration.js";
import { createFeishuHttp, systemFeishuClock, type FeishuFetch, type FeishuClock, type FeishuResult } from "./http.js";
import { createTokenManager } from "./token.js";
import { createFeishuApi, type FeishuApi } from "./api.js";
import { createFeishuConnector, type FeishuSocket, type FeishuConnectorView } from "./connector.js";
import {
  createFeishuSessions,
  feishuBindingKey,
  type FeishuSessionView,
  type FeishuManagedSession,
} from "./sessions.js";
import {
  createFeishuAdmission,
  type FeishuAdmissionDeps,
  type FeishuIdentityContext,
  type FeishuInstallation,
} from "./admission.js";
import { createFeishuRequests, feishuBatchIdentity, feishuDigest, type FeishuRequestEvent } from "./requests.js";
import { createFeishuRouter, type FeishuRouterIntent } from "./router.js";
import { createFeishuInbound, type FeishuMessage, type FeishuInboundIntent } from "./inbound.js";
import { createFeishuOutbox, type OutboxTarget, type OutboxMessage, type SettledGroup } from "./outbox.js";
import { renderReply, renderNotice, neutralizeMarkdown } from "./render.js";
import { createFeishuRuns, type FeishuRunEvent, type FeishuRunResult } from "./runs.js";
import { createFeishuDialogs } from "./dialogs.js";
import { createFeishuDiagnostics, feishuPatchMessage } from "./diagnostics.js";
import { safeFeishuLink } from "./link.js";
import { createFeishuSessionCard } from "./session-card.js";
import { createFeishuFiles, feishuFileCandidates, type FeishuFilesDeps } from "./files.js";
import { createFeishuNotify, type FeishuIdleEvidence } from "./notify.js";
import {
  createFeishuSecurity,
  createLoginApprovalPort,
  createNoticeBudget,
  parseApprovalTarget,
  type FeishuLoginApproval,
} from "./security.js";
import { bounded, createFeishuWork, feishuKey, messageText, object } from "./runtime.js";
import type { FeishuState, FeishuBinding, FeishuRequestRecord, FeishuNonce } from "./state.js";
import type { SecurityEventBus } from "../security-events.js";

/** Exact structural projection of the existing hub bus; no hub assembly types cross this port. */
export type FeishuServiceEvent =
  | FeishuRunEvent
  | { type: "dialogs"; agentKey: string; epoch: string; open: DialogWire[]; closed: DialogClosedWire[] }
  | { type: "spawns" }
  | { type: "status"; agentKey: string }
  | { type: "fleet"; agentKey: string };
export interface FeishuSpawnPort extends Pick<
  FreshSpawnContext,
  "dirs" | "supervisor" | "firstPrompt" | "prefs" | "registerTimeoutS"
> {
  restore?: boolean;
  relaunch?: SpawnSupervisor["relaunch"];
  lookup(spawnId: string): { agentKey?: string; sessionId?: string; terminal: boolean } | undefined;
}
export interface FeishuBotServiceDeps {
  stateDir: string;
  config: FeishuBotHubConfig;
  /** SAME object as HTTP uses (FA hoists it). */
  limit: CmdLimit;
  commands: FeishuAdmissionDeps["commands"];
  sessions: { views(): readonly FeishuSessionView[]; managed(): readonly FeishuManagedSession[] };
  events: {
    subscribe(listener: (event: FeishuServiceEvent) => void): () => void;
    /** Authoritative registry dialog slots only (absence is NOT an empty list). */
    dialogs?(): readonly { agentKey: string; epoch: string; open: DialogWire[]; closed: DialogClosedWire[] }[];
  };
  uploads?: FeishuFilesDeps["uploads"];
  preview?: FeishuFilesDeps["preview"];
  spawn?: FeishuSpawnPort;
  idleEvidence?(agentKey: string): FeishuIdleEvidence | undefined;
  /** Authenticated web session link (no token/query credentials). */
  link?(agentKey: string): string;
  /** LAN security r2 §4.3: the hub security bus. Absent ⇒ no security alerts. */
  security?: SecurityEventBus;
  /** LAN security r2 §5.7: the login core's approval-decision sink. Absent ⇒ decisions are dropped. */
  onApprovalDecision?(challengeId: string, allowed: boolean, gen: number): void;
  onStatus?(status: FsbInfoData): void;
  log?(event: {
    event: string;
    reason?: string;
    code?: string | number;
    eventType?: string;
    messageType?: string;
    msg?: string;
  }): void;
  // Testable platform seams; none changes destination admission.
  clock?: FeishuClock;
  fs?: FeishuFs;
  fetch?: FeishuFetch;
  webSocket?: (url: string) => FeishuSocket;
  api?: FeishuApi;
  /** session-card boot adoption budget before the connector starts anyway (default 3000 ms) */
  cardAdoptionBudgetMs?: number;
}
const NEW_SESSION = "feishu:new";
const HELP_TEXT = [
  "/list — 列出可用会话（卡片可直接点击切换）",
  "/use <n|sid-prefix|name> — 绑定/切换会话",
  "/cur — 查看当前绑定会话",
  "/new <dir> [first message] — 创建并绑定新会话",
  "/unbind — 解除当前绑定",
  "/file <abs path> — 发送指定文件",
  "/help — 显示命令帮助",
  "群聊中请先 @ 机器人，再输入命令。",
].join("\n");
const mask = (id: string) => (id.length > 10 ? `${id.slice(0, 5)}…${id.slice(-4)}` : "ou_…");
/** Owner pages for real decode failures: at most one per decode code per 10 min (user ruling 2026-10-19). */
const UNDECODABLE_OWNER_NOTICE_GAP_MS = 600_000;
/** Benign noisy audit classes (unsubscribed event types, stale redeliveries) log a bounded sample only. */
const AUDIT_SAMPLE_GAP_MS = 600_000;
function undecodableOwnerReason(code: string | undefined): string {
  return `undecodable:${typeof code === "string" && /^[a-z0-9-]{1,48}$/.test(code) ? code : "unknown"}`;
}
const simpleCard = (text: string, buttons: Array<{ label: string; n: string }> = []) =>
  JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        { tag: "markdown", content: neutralizeMarkdown(text) },
        ...buttons.map((b) => ({
          tag: "button",
          text: { tag: "plain_text", content: b.label },
          behaviors: [{ type: "callback", value: { n: b.n } }],
        })),
      ],
    },
  });

/** §5.7 login-approval card: user/IP/device + approve/deny buttons, then a status line. */
function loginApprovalCard(
  info: { user: string; ip: string; device: string },
  state: "pending" | "approved" | "denied" | "expired",
  nonces?: { approve: string; deny: string },
): string {
  const status = state === "approved" ? "已批准" : state === "denied" ? "已拒绝" : state === "expired" ? "已失效" : "";
  const text =
    state === "pending"
      ? `登录审批请求\n用户：${info.user}\nIP：${info.ip}\n设备：${info.device}\n请在 2 分钟内批准或拒绝。`
      : `登录审批：${status}`;
  const buttons =
    nonces !== undefined
      ? [
          { label: "批准", n: nonces.approve },
          { label: "拒绝", n: nonces.deny },
        ]
      : [];
  return simpleCard(text, buttons);
}
export function createFeishuBotService(deps: FeishuBotServiceDeps) {
  const clock = deps.clock ?? systemFeishuClock;
  const dir = join(deps.stateDir, "feishu-bot");
  const credentials = createCredentialStore({ dir, clock, ...(deps.fs ? { fs: deps.fs } : {}) });
  const degraded = new Set<string>();
  let runtime: ReturnType<typeof buildRuntime> | undefined;
  let running = false,
    disposed = false,
    startedAt = 0;
  let starting: Promise<void> | undefined, stopping: Promise<void> | undefined, disposing: Promise<void> | undefined;
  let adminBusy = false,
    lifecycle = 0;
  let connectorView: FeishuConnectorView | undefined;
  // Bounded-sample timestamps for noisy inbound audit classes; service-lifetime, not per-runtime.
  const auditSampled = new Map<string, number>();
  // Snapshot counters cover the whole service lifetime (including reset/replacement), not one runtime.
  const retired = {
    received: 0,
    duplicates: 0,
    sent: 0,
    failed: 0,
    reconnects: 0,
    dropped: {} as Record<string, number>,
    lastCode: undefined as string | undefined,
  };
  const state = createFeishuState({
    dir,
    clock,
    ...(deps.fs ? { fs: deps.fs } : {}),
    onHealth: ({ persistFailed }) => {
      if (persistFailed) {
        degraded.add("persist-failed");
        runtime?.connector.pause();
      } else {
        degraded.delete("persist-failed");
        if (running) {
          runtime?.connector.resume();
          runtime?.outbox.resume();
          runtime?.sessionCard.onPersistRecovered(); // G3: compensate degraded cards (in-tail, once each)
        }
      }
      publish();
    },
  });
  function log(
    event: string,
    reason?: string,
    code?: string | number,
    diag?: { eventType?: string; messageType?: string },
  ) {
    try {
      deps.log?.({
        event,
        ...(reason ? { reason } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(diag?.eventType ? { eventType: diag.eventType } : {}),
        ...(diag?.messageType ? { messageType: diag.messageType } : {}),
      });
    } catch {
      /* diagnostic only */
    }
  }
  function info(): FsbInfoData {
    const creds = credentials.current(),
      view = runtime?.connector.snapshot() ?? connectorView;
    const reasons = [...new Set([...degraded, ...state.degradedReasons(), ...(view?.reason ? [view.reason] : [])])];
    const bindings = state.bindings.list(),
      rows = deps.sessions.views();
    const ob = runtime?.outbox.stats();
    const dropped: Record<string, number> = { ...retired.dropped };
    for (const [key, value] of Object.entries(runtime ? (view?.counters ?? {}) : {}))
      if (key !== "in" && key !== "duplicate") dropped[key] = (dropped[key] ?? 0) + value;
    return {
      status: !running
        ? credentials.status() === "absent" && !startedAt
          ? "unconfigured"
          : "stopped"
        : credentials.status() === "unsafe" || reasons.length
          ? "degraded"
          : !creds
            ? registration.active
              ? "setup"
              : "unconfigured"
            : runtime?.authFailed
              ? "auth_failed"
              : (view?.status ?? "connecting"),
      ...(reasons.length ? { degraded: reasons } : {}),
      ...(creds ? { brand: creds.brand } : {}),
      gen: creds?.gen ?? 0,
      ...(startedAt ? { uptimeMs: Math.max(0, clock.now() - startedAt) } : {}),
      reconnects: retired.reconnects + (runtime ? (view?.reconnects ?? 0) : 0),
      ...(view?.lastClose ? { lastClose: view.lastClose } : {}),
      counters: {
        in: retired.received + (runtime?.received ?? 0),
        dup: retired.duplicates + (runtime?.duplicates ?? 0),
        dropped,
      },
      outbox: {
        ok: retired.sent + (ob?.sent ?? 0),
        failed: retired.failed + (ob?.failed ?? 0),
        ...(ob?.lastCode || retired.lastCode ? { lastCode: ob?.lastCode ?? retired.lastCode! } : {}),
      },
      bindings: {
        total: bindings.length,
        offline: bindings.filter((b) => !rows.some((v) => v.live && v.sessionId === b.sessionId)).length,
        ambiguous: bindings.filter((b) => rows.filter((v) => v.live && v.sessionId === b.sessionId).length > 1).length,
      },
      caps: runtime?.caps ?? { cards: "unknown", reactions: "unknown", files: "unknown", cardCallback: "unknown" },
      keepalive: credentials.status() === "loaded" || credentials.status() === "unsafe",
      ...(creds ? { owner: mask(creds.ownerOpenId) } : {}),
      allow: state.allowList.list().map(mask),
    };
  }
  function publish() {
    try {
      deps.onStatus?.(info());
    } catch {
      /* local diagnostic cannot affect ACK */
    }
  }
  function health(reason: string, detail?: { eventType?: string; code?: string; messageType?: string }) {
    log("health", reason, detail?.code, {
      ...(detail?.eventType ? { eventType: detail.eventType } : {}),
      ...(detail?.messageType ? { messageType: detail.messageType } : {}),
    });
    if (reason === "persist-failed") {
      degraded.add(reason);
      runtime?.connector.pause();
    }
    if (reason === "undecodable-events") {
      degraded.add(reason);
      // Real decode failures page the owner debounced per decode code (≤1/10 min, restart-safe
      // via the outbox key window); unsupported-event/stale never reach this path.
      const noticeReason = undecodableOwnerReason(detail?.code);
      const current = runtime;
      current?.work.run(() => current.notify.owner(noticeReason, { gapMs: UNDECODABLE_OWNER_NOTICE_GAP_MS }));
    }
    publish();
  }
  async function install(input: CredentialInput, guard: () => boolean) {
    // Stop is FIRST, even when replacement eventually fails. Generation fences all old follow-ups.
    await stopRuntime();
    if (disposed || !guard()) return { ok: false as const, reason: "cancelled" };
    const result = await bounded(credentials.commit(input, { guard }), 2_000, clock);
    if (!result.ok) {
      if (!disposed) await startLoaded();
      return { ok: false as const, reason: result.reason };
    }
    // Same-app replacement still invalidates old request/nonces (F6 generation ruling).
    for (const id of state.allowList.list()) state.nonces.purgeOperator(id);
    for (const r of state.requests.list({ states: ["received", "dispatching", "accepted", "uncertain"] })) {
      if (r.state === "received") state.requests.transition(r.id, "revoked");
      else {
        if (r.state === "dispatching") state.requests.transition(r.id, "uncertain");
        state.requests.transition(r.id, "unattributed", { code: "installation-changed" });
      }
    }
    await bounded(state.commit(), 1_500, clock);
    if (!disposed && guard()) {
      await startLoaded();
      const current = runtime;
      current?.work.run(() => current.notify.owner("configured"));
    }
    return { ok: true as const };
  }
  const registration = createRegistration({
    credentialsState: () => (credentials.status() === "unsafe" ? "unsafe" : credentials.current() ? "present" : "none"),
    commit: install,
    clock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  function buildRuntime(api: FeishuApi, token: ReturnType<typeof createTokenManager>) {
    let active = true,
      received = 0,
      duplicates = 0,
      unsubscribe: (() => void) | undefined,
      maintenance: unknown;
    let authFailed = false;
    const caps: FsbInfoData["caps"] = {
      cards: "unknown",
      reactions: "unknown",
      files: "unknown",
      cardCallback: "unknown",
    };
    const work = createFeishuWork(clock, () => {
      if (active) health("background-failed");
    });
    // Finals have their OWN 256 slots; a flood of notices/file actions cannot drop a completed run.
    const replies = createFeishuWork(
      clock,
      () => {
        if (active) health("reply-failed");
      },
      256,
    );
    const reactions = createFeishuWork(
      clock,
      () => {
        if (active) health("reaction-failed");
      },
      512,
    );
    const commandTasks = new Set<Promise<unknown>>();
    const bootFresh = new Set(
      state.requests
        .list({ states: ["accepted"] })
        .filter((r) => r.sessionId === NEW_SESSION)
        .map((r) => r.id),
    );
    const sendWaiters = new Map<
      string,
      { resolve(value: { messageId: string; chatId: string; threadId?: string } | undefined): void; timer: unknown }
    >();
    const installation = (): FeishuInstallation | undefined => {
      const c = credentials.current();
      return c ? { ...c, active: active && running && !disposed && !state.persistFailed() } : undefined;
    };
    const sessions = createFeishuSessions({ ...deps.sessions, bindings: state.bindings.list }, clock.now);
    const label = (sid: string) => sessions.rows().find((r) => r.sessionId === sid)?.label ?? sid.slice(0, 6);
    const link = (agentKey: string) => safeFeishuLink(deps.link?.(agentKey));
    const diagnose = createFeishuDiagnostics(deps.log, clock.now);
    const targetFor = (r: {
      chatType: "p2p" | "group";
      threadId?: string | undefined;
      triggerMessageId: string;
    }): OutboxTarget =>
      r.chatType === "p2p"
        ? { scope: "p2p", via: "reply", messageId: r.triggerMessageId }
        : r.threadId
          ? { scope: "topic", messageId: r.triggerMessageId }
          : { scope: "group-root", messageId: r.triggerMessageId };
    const recentTriggers = new Map<string, { messageId: string; threadId?: string }>();
    const lastRequest = (binding: FeishuBinding) =>
      state.requests
        .list()
        .filter((r) => r.bindingKey === binding.key && r.state !== "merged")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
    const bindingTarget = (binding: FeishuBinding): OutboxTarget | undefined => {
      const r = lastRequest(binding),
        recent = recentTriggers.get(binding.key);
      if (binding.chatType === "group" && recent && recent.threadId === binding.threadId)
        return { scope: "topic", messageId: recent.messageId };
      return binding.chatType === "p2p"
        ? { scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: binding.chatId }
        : r && r.threadId === binding.threadId
          ? targetFor(r)
          : undefined;
    };
    const outbox = createFeishuOutbox({
      state,
      api,
      clock,
      onSettled: settled,
      onEvent: (event) => {
        if (event.event === "capability-denied") capability(event.msgType === "interactive" ? "cards" : "files", false);
        if (event.event === "paused") {
          authFailed = true;
          work.run(() => notify.owner("auth_failed"));
        }
        if (event.event === "resumed") authFailed = false;
        if (event.event === "sent") {
          if (event.msgType === "interactive") capability("cards", true);
          else if (event.msgType === "image" || event.msgType === "file") capability("files", true);
        }
        publish();
      },
    });
    const budget = createNoticeBudget(clock);
    const notify = createFeishuNotify({
      state,
      now: clock.now,
      owner: () => credentials.current()?.ownerOpenId,
      enabled: deps.config.notify === "bound",
      label,
      target: bindingTarget,
      send: outbox.enqueueNotice,
      budget,
    });
    // LAN security r2 §4.3: high-risk alerts, one shared budget with notify. Subscribes the hub
    // security bus; absent bus or `securityAlerts:false` ⇒ inert (and `undefined`).
    const security =
      deps.config.securityAlerts === true && deps.security !== undefined
        ? createFeishuSecurity({
            security: deps.security,
            clock,
            owner: () => credentials.current()?.ownerOpenId,
            budget,
            send: outbox.enqueueNotice,
          })
        : undefined;
    // LAN security r2 §5.7: the Feishu login-approval port (per runtime — it needs the live work slot
    // and the outbox). `patchCard` re-renders the full card from the original info we keep keyed by
    // messageId, so the approve/deny patch still shows user/IP/device.
    const approvalCards = new Map<string, { user: string; ip: string; device: string }>();
    const approval = createLoginApprovalPort({
      state,
      clock,
      work,
      installation: () => {
        const c = credentials.current();
        const tenantKey = state.tenant.get();
        return c !== undefined && tenantKey !== undefined
          ? { gen: c.gen, ownerOpenId: c.ownerOpenId, tenantKey }
          : undefined;
      },
      sendCard: async (input) => {
        if (!active) return undefined;
        const id = `la${randomBytes(9).toString("base64url")}`;
        const sent = await sendCard(
          id,
          { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: input.owner },
          loginApprovalCard(input, "pending"),
          input.owner,
        );
        if (sent === undefined) return undefined;
        approvalCards.set(sent.messageId, { user: input.user, ip: input.ip, device: input.device });
        return { chatId: sent.chatId, messageId: sent.messageId };
      },
      patchCard: async (messageId, cardState, nonces) => {
        const info = approvalCards.get(messageId) ?? { user: "", ip: "", device: "" };
        if (cardState !== "pending") approvalCards.delete(messageId);
        return patch(messageId, loginApprovalCard(info, cardState, nonces));
      },
      onDecision: deps.onApprovalDecision ?? (() => {}),
    });
    function capability(name: FeishuCapabilityName, ok: boolean) {
      caps[name] = ok ? "ok" : "denied";
      if (ok) degraded.delete(`capability-denied:${name}`);
      else {
        degraded.add(`capability-denied:${name}`);
        work.run(() => notify.owner(`capability-denied:${name}`));
      }
      publish();
    }
    async function notice(target: OutboxTarget, text: string, lane?: string, key?: string) {
      if (!active) return;
      await outbox.enqueueNotice({
        target,
        message: renderNotice({ label: "pi", text }),
        ...(lane ? { laneKey: lane } : {}),
        ...(key ? { key } : {}),
      });
    }
    async function bindingNotice(binding: FeishuBinding, text: string) {
      const target = bindingTarget(binding);
      if (target) await notice(target, text, binding.chatId);
    }
    async function sendCard(id: string, target: OutboxTarget, card: string, lane: string) {
      if (!active || sendWaiters.size >= 64) return undefined;
      const promise = new Promise<{ messageId: string; chatId: string; threadId?: string } | undefined>((resolve) => {
        const timer = clock.setTimeout(() => {
          sendWaiters.delete(id);
          resolve(undefined);
        }, 30_000);
        sendWaiters.set(id, { resolve, timer });
      });
      const result = await outbox.enqueueFinal({
        requestId: id,
        target,
        messages: [{ msgType: "interactive", content: card }],
        laneKey: lane,
      });
      if (!result.ok) {
        const waiter = sendWaiters.get(id);
        clock.clearTimeout(waiter?.timer);
        waiter?.resolve(undefined);
        sendWaiters.delete(id);
      }
      return promise;
    }
    async function patch(messageId: string, card: string): Promise<FeishuResult<void>> {
      if (!active) return { ok: false, kind: "aborted", reason: "inactive", retryable: false, effect: "none" };
      let result: FeishuResult<void>;
      try {
        result = await bounded(api.patchCard({ messageId, card }), 8_000, clock);
      } catch {
        result = { ok: false, kind: "timeout", reason: "patch-unconfirmed", retryable: false, effect: "unknown" };
      }
      if (result.ok) capability("cards", true);
      else {
        diagnose({
          event: "card-patch-failed",
          reason: result.reason,
          ...(result.code === undefined ? {} : { code: result.code }),
          msg: feishuPatchMessage(result.msg),
        });
        if (result.capabilityDenied) capability("cards", false);
      }
      return result;
    }
    const admission = createFeishuAdmission({
      state,
      installation,
      sessions,
      limit: deps.limit,
      commands: {
        ...deps.commands,
        request(...args) {
          const frame = args[0],
            record = state.requests.get(frame.id);
          const pin =
            frame.cmd.op === "prompt" && !frame.queryOnly
              ? deps.uploads?.pinForPrompt({
                  principal: `feishu:${record?.installGen}:${record?.senderOpenId}`,
                  text: frame.cmd.text,
                })
              : undefined;
          if (pin && !pin.ok)
            return Promise.resolve({
              t: "cmd_result" as const,
              rid: frame.rid,
              id: frame.id,
              ok: false as const,
              code: "E_BAD_REQUEST" as const,
              message: "附件已不可用，请重新发送",
              retryable: false,
              effect: "none" as const,
            });
          const result = deps.commands.request(...args);
          commandTasks.add(result);
          void result
            .then(
              (value) => {
                if (pin?.ok) deps.uploads?.settlePins(pin.token, value.ok ? "referenced" : "released");
              },
              () => {
                if (pin?.ok) deps.uploads?.settlePins(pin.token, "released");
              },
            )
            .finally(() => commandTasks.delete(result));
          return result;
        },
      },
    });
    async function observeFile<T>(pending: Promise<FeishuResult<T>>): Promise<FeishuResult<T>> {
      const result = await pending;
      if (!active) return result;
      if (result.ok) capability("files", true);
      else if (result.capabilityDenied) capability("files", false);
      else if (result.auth === "auth_failed") {
        authFailed = true;
        work.run(() => notify.owner("auth_failed"));
        publish();
      }
      return result;
    }
    const files = createFeishuFiles({
      dir,
      api: {
        downloadResource: (p) => observeFile(api.downloadResource(p)),
        uploadImage: (p) => observeFile(api.uploadImage(p)),
        uploadFile: (p) => observeFile(api.uploadFile(p)),
      },
      clock,
      inbound: deps.config.files.inbound,
      maxInboundMiB: deps.config.files.maxInboundMiB,
      outbound: deps.config.files.outbound,
      ...(deps.uploads ? { uploads: deps.uploads } : {}),
      ...(deps.preview ? { preview: deps.preview } : {}),
      resolve: (message) => {
        const key = feishuBindingKey(message.chatType, message.chatId, message.threadId),
          sid = key && state.bindings.get(key)?.sessionId;
        const r = sid ? sessions.resolve(sid) : undefined;
        return r?.ok ? r.view : undefined;
      },
    });
    const runs = createFeishuRuns({
      clock,
      finish: (result) => {
        if (
          !replies.run(async () => {
            try {
              await finishRun(result);
            } catch {
              if (active) {
                const current = state.requests.get(result.request.id);
                if (current?.state === "accepted" || current?.state === "uncertain")
                  state.requests.transition(current.id, "reply-failed", { code: "reply-error" });
                await state.commit();
                health("reply-failed");
              }
            }
          })
        ) {
          const request = state.requests.get(result.request.id);
          if (request?.state === "accepted" || request?.state === "uncertain")
            state.requests.transition(request.id, "reply-failed", { code: "reply-busy" });
          health("reply-busy");
        }
      },
      reaction: (r, add) => {
        reactions.run(() => reaction(r, add));
      },
      transfer: (r, sid) => {
        const binding = state.bindings.get(r.bindingKey);
        if (binding?.sessionId === r.sessionId && binding.rev === r.bindingRev) {
          state.bindings.set(binding.key, { ...binding, sessionId: sid, offline: null });
          work.run(async () => {
            await state.commit();
            await notice(targetFor(r), `会话已随请求转移到 ${label(sid)}`, r.chatId);
          });
        }
      },
    });
    const requests = createFeishuRequests({
      state,
      installation,
      admission,
      clock,
      debounceMs: deps.config.debounceMs,
      staleMessageS: deps.config.staleMessageS,
      onHealth: (e) => health(e.reason),
      emit: requestEvent,
    });
    const dialogs = createFeishuDialogs({
      state,
      admission,
      installation,
      clock,
      session: (key) => deps.sessions.views().find((v) => v.live && v.agentKey === key)?.sessionId,
      target: bindingTarget,
      operator: (binding) => lastRequest(binding)?.senderOpenId ?? credentials.current()?.ownerOpenId,
      link,
      sendCard,
      patch,
      deleteMessage: (messageId) => api.deleteMessage({ messageId }),
      notice: bindingNotice,
      log: diagnose,
    });
    const sessionCard = createFeishuSessionCard({
      state,
      sessions,
      installation,
      authorize: (identity) => admission.authorize(identity),
      cardsDenied: () => caps.cards === "denied",
      sendCard,
      patchCard: (p) => api.patchCard(p),
      notice,
      capability,
      clock,
      onError: () => {
        if (active) health("background-failed");
      },
      log,
    });
    const router = createFeishuRouter({
      state,
      sessions,
      requests,
      groupRootTopics: deps.config.groupRootTopics,
      spawnScope: deps.config.spawnScope,
      preparePayload: files.prepare,
      emit: (intent) => {
        work.run(() => routerIntent(intent));
      },
      onHealth: (e) => health(e.reason),
    });
    const inbound = createFeishuInbound({
      state,
      installation,
      admission,
      allowGroups: deps.config.allowGroups,
      staleMessageS: deps.config.staleMessageS,
      now: clock.now,
      onHealth: (e) =>
        health(e.reason, {
          ...(e.eventType ? { eventType: e.eventType } : {}),
          ...(e.code ? { code: e.code } : {}),
          ...(e.messageType ? { messageType: e.messageType } : {}),
        }),
      prepare: async (message, identity) => {
        // Text answers are effects too: defer until inbound has committed dedup, just like cards.
        const bindingKey = feishuBindingKey(message.chatType, message.chatId, message.threadId);
        if (
          !message.text.startsWith("/") &&
          state.dialogCards.list().some((c) => c.bindingKey === bindingKey && c.status === "open")
        )
          return {
            durable() {
              work.run(() => dialogs.text(message, identity));
            },
          };
        const prepared = await router.prepare(message, identity);
        if (
          prepared.drop ||
          !state.requests.list({ states: ["received"] }).some((r) => r.payload?.messageIds.includes(message.messageId))
        )
          files.settle(message.messageId, "released");
        return {
          ...prepared,
          durable() {
            if (bindingKey && recentTriggers.size < 256)
              recentTriggers.set(bindingKey, {
                messageId: message.messageId,
                ...(message.threadId ? { threadId: message.threadId } : {}),
              });
            prepared.durable?.();
          },
        };
      },
      emit: (intent) => {
        // G1: session-pick is enqueued synchronously by the per-card controller — a saturated
        // generic work pool can never silently drop a redeemed button click.
        if (intent.type === "action" && intent.record.action === "session-pick") {
          capability("cardCallback", true);
          sessionCard.pick(intent.record, intent.identity, intent.eventId);
          return;
        }
        work.run(() => inboundIntent(intent));
      },
      audit: (audit) => {
        // Noisy benign classes (unsubscribed event types, stale redeliveries) log a bounded sample;
        // their authoritative counts live in the connector's dropped{} status counters.
        if (audit.reason === "unsupported-event" || audit.reason === "stale") {
          const lastLogged = auditSampled.get(audit.reason);
          if (lastLogged !== undefined && clock.now() - lastLogged < AUDIT_SAMPLE_GAP_MS) return;
          auditSampled.set(audit.reason, clock.now());
        }
        log("inbound", audit.reason, undefined, {
          ...(audit.eventType !== "unknown" ? { eventType: audit.eventType } : {}),
          ...(audit.messageType ? { messageType: audit.messageType } : {}),
        });
      },
    });
    const connector = createFeishuConnector({
      credentials: credentials.current()!,
      api,
      state,
      clock,
      ...(deps.webSocket ? { webSocket: deps.webSocket } : {}),
      handleEvent: async (raw) => {
        received++;
        const result = await inbound.handle(raw);
        if (result.reason.includes("duplicate")) duplicates++;
        publish();
        return result;
      },
      onUndecodable: (code) => {
        if (!active) return;
        degraded.add("undecodable-events");
        work.run(() => notify.owner(undecodableOwnerReason(code), { gapMs: UNDECODABLE_OWNER_NOTICE_GAP_MS }));
      },
      onStatus: (view) => {
        if (!active) return;
        connectorView = view;
        if (view.status === "auth_failed" || view.status === "conn_limit" || view.status === "degraded")
          work.run(() => notify.owner(view.status === "degraded" ? (view.reason ?? "ws-unavailable") : view.status));
        publish();
      },
    });
    async function reaction(request: FeishuRequestRecord, add: boolean) {
      if (!active) return;
      if (add) {
        const result = await bounded(
          api.addReaction({ messageId: request.triggerMessageId, emojiType: "Typing" }),
          8_000,
          clock,
        );
        if (result.ok) {
          capability("reactions", true);
          const current = state.requests.get(request.id);
          if (current?.state === "accepted" && runs.has(request.id) && active) {
            state.requests.patch(request.id, { reactionId: result.data.reactionId });
            await state.commit();
          } else
            await bounded(
              api.deleteReaction({ messageId: request.triggerMessageId, reactionId: result.data.reactionId }),
              8_000,
              clock,
            );
        } else if (result.capabilityDenied) capability("reactions", false);
      } else {
        const id = state.requests.get(request.id)?.reactionId ?? request.reactionId;
        if (id)
          await bounded(api.deleteReaction({ messageId: request.triggerMessageId, reactionId: id }), 8_000, clock);
      }
    }
    function requestEvent(event: FeishuRequestEvent) {
      if (!active) return;
      runs.request(event);
      if (event.type === "accepted" || event.type === "rejected" || event.type === "expired")
        for (const id of event.request.payload?.messageIds ?? [])
          files.settle(id, event.type === "accepted" ? "referenced" : "released");
      if (event.type === "rejected" || event.type === "expired")
        work.run(() =>
          notice(
            targetFor(event.request),
            `${label(event.request.sessionId)}: 请求未执行（${event.code}），请重发。`,
            event.request.chatId,
          ),
        );
      if (event.type === "uncertain")
        work.run(() =>
          event.request.sessionId === NEW_SESSION
            ? notice(
                targetFor(event.request),
                "创建结果未确认；首条消息不会自动重发，请 /list 查看。",
                event.request.chatId,
              )
            : resendCard(event.request),
        );
    }
    async function finishRun(result: FeishuRunResult) {
      if (!active) return;
      const r = state.requests.get(result.request.id);
      if (!r || !["dispatching", "accepted", "uncertain"].includes(r.state)) return;
      if (result.kind === "unattributed" || result.kind === "rejected" || result.kind === "expired") {
        if (r.state === "dispatching") state.requests.transition(r.id, "uncertain");
        state.requests.transition(r.id, result.kind, { code: result.kind });
        await state.commit();
        if (result.kind === "unattributed") {
          const b = state.bindings.get(r.bindingKey),
            current = deps.sessions.views().find((v) => v.agentKey === r.agentKey && v.live);
          if (b && current && current.sessionId !== r.sessionId) {
            state.bindings.set(b.key, { ...b, offline: "session-changed" });
            await state.commit();
          }
        }
        await notice(
          targetFor(r),
          result.kind === "unattributed"
            ? `${label(r.sessionId)}: 已送达，结果无法确认归属 — 在 web 查看：${link(r.agentKey ?? "")}`
            : result.kind === "expired"
              ? `${label(r.sessionId)}: 未收到结束信号（expired）`
              : `${label(r.sessionId)}: 请求已被撤回/拒绝`,
          r.chatId,
          `${r.id}-${result.kind}`,
        );
        return;
      }
      let rendered = renderReply({
        kind: result.kind,
        label: label(r.sessionId),
        shortId: r.sessionId,
        text: result.text + (result.continued ? "\n\ncontinued by another input" : ""),
        truncated: result.truncated,
        ...(r.chatType === "group" ? { mention: r.senderOpenId } : {}),
        ...(result.stopReason ? { failure: { stopReason: result.stopReason } } : {}),
      });
      let messages: OutboxMessage[] = [...rendered.parts];
      if (rendered.overflow) {
        const upload = await bounded(
          api.uploadFile({ bytes: Buffer.from(rendered.overflow.fullText), fileName: rendered.overflow.fileName }),
          30_000,
          clock,
        );
        if (upload.ok) messages.push({ msgType: "file", content: JSON.stringify({ file_key: upload.data.fileKey }) });
        else {
          rendered = renderReply({
            kind: result.kind,
            label: label(r.sessionId),
            text: result.text,
            truncated: result.truncated,
            overflow: "truncate",
            ...(r.chatType === "group" ? { mention: r.senderOpenId } : {}),
          });
          messages = [...rendered.parts];
        }
      }
      if (!active) return;
      const queued = await outbox.enqueueFinal({ requestId: r.id, target: targetFor(r), messages, laneKey: r.chatId });
      if (!queued.ok) {
        state.requests.transition(r.id, "reply-failed", { code: `outbox-${queued.refused}` });
        await state.commit();
      } else if (deps.config.files.outbound !== "off") await outboundCandidates(r, result.text);
    }
    async function settled(group: SettledGroup) {
      if (!active) throw new Error("stopped");
      if (group.requestId) {
        const waiter = sendWaiters.get(group.requestId);
        if (!waiter && state.dialogCards.get(group.requestId))
          await dialogs.delivered(group.requestId, group.parts.find((p) => p.messageId)?.messageId);
        if (waiter) {
          clock.clearTimeout(waiter.timer);
          sendWaiters.delete(group.requestId);
          const part = group.parts.find((p) => p.messageId);
          waiter.resolve(
            part?.messageId && part.chatId
              ? {
                  messageId: part.messageId,
                  chatId: part.chatId,
                  ...(part.threadId ? { threadId: part.threadId } : {}),
                }
              : part?.messageId
                ? { messageId: part.messageId, chatId: "" }
                : undefined,
          );
        }
        const request = state.requests.get(group.requestId);
        if (request && ["accepted", "uncertain"].includes(request.state)) {
          state.requests.transition(request.id, group.replyFailed ? "reply-failed" : "replied", {
            ...(group.code ? { code: group.code } : {}),
          });
          if (!(await state.commit())) throw new Error("persist-failed");
        }
        if (request && (group.outcome === "partial" || group.swept || group.code === "expired-uncertain")) {
          log("reply-incomplete", group.swept ? "swept" : (group.code ?? group.outcome));
          await notice(
            targetFor(request),
            group.swept
              ? `${group.swept} 部分无法核实 — 在 web 查看`
              : group.code === "expired-uncertain"
                ? "回复可能已经送达，请在 web 查看"
                : "回复部分发送失败，请在 web 查看",
            request.chatId,
            `${request.id}-partial`,
          );
        }
      }
    }
    async function actionCard(r: FeishuRequestRecord, text: string, action: string, target: string, labelText: string) {
      const install = installation(),
        tenantKey = state.tenant.get();
      if (!install?.active || !tenantKey) return;
      const id = `fa${feishuKey(`${r.id}:${action}:${target}`)}`;
      const sent = await sendCard(id, targetFor(r), simpleCard(text), r.chatId);
      if (!sent || !active) return;
      const nonce = state.nonces.issue({
        installGen: install.gen,
        tenantKey,
        operatorOpenId: r.senderOpenId,
        chatId: sent.chatId || r.chatId,
        messageId: sent.messageId,
        action,
        target,
      });
      if (!nonce.ok) {
        await patch(sent.messageId, simpleCard(`${text}\n按钮不可用，请到 web 查看或使用文字命令。`));
        return;
      }
      if (!(await state.commit()) || !active) return;
      await patch(sent.messageId, simpleCard(text, [{ label: labelText, n: nonce.value.nonce }]));
    }
    async function resendCard(r: FeishuRequestRecord) {
      await actionCard(r, `${label(r.sessionId)}: 可能未送达。请先在 web 核实后再重发。`, "resend", r.id, "重发");
    }
    async function outboundCandidates(r: FeishuRequestRecord, text: string) {
      const view = sessions.resolve(r.sessionId);
      if (!view.ok) return;
      let auto = 0,
        buttons = 0;
      const controller = new AbortController(),
        end = clock.now() + 1_500;
      try {
        for (const path of feishuFileCandidates(text)) {
          if (!active || clock.now() >= end) break;
          const file = await files.read(path, controller.signal, Math.max(0, end - clock.now()));
          if (!file) continue;
          if (auto < 3 && (await files.autoEligible(file, view.view.cwd, r.chatType === "p2p", true))) {
            const message = await files.upload(file, controller.signal);
            if (message && active) {
              await outbox.enqueueFinal({
                requestId: `fi${feishuKey(`${r.id}:${auto}`)}`,
                target: targetFor(r),
                messages: [message],
                laneKey: r.chatId,
              });
              auto++;
            }
          } else if (buttons < 5) {
            await actionCard(
              r,
              `发送文件：${file.name}（${file.bytes.length} B）`,
              "file",
              JSON.stringify({ request: r.id, path }),
              "发送",
            );
            buttons++;
          }
        }
      } finally {
        controller.abort();
      }
    }
    async function explicitFile(r: FeishuRequestRecord, path: string, identity: FeishuIdentityContext) {
      const authorized = () =>
        admission.authorize(identity).ok &&
        state.bindings.get(r.bindingKey)?.rev === r.bindingRev &&
        state.bindings.get(r.bindingKey)?.sessionId === r.sessionId &&
        sessions.resolve(r.sessionId).ok;
      if (!authorized()) return;
      if (deps.config.files.outbound === "off") {
        await notice(targetFor(r), "文件发送已关闭", r.chatId);
        return;
      }
      const controller = new AbortController();
      try {
        const file = await files.read(path, controller.signal);
        if (!file || !authorized() || !active) {
          await notice(targetFor(r), "refused", r.chatId);
          return;
        }
        const msg = await files.upload(file, controller.signal);
        if (msg && active && authorized())
          await outbox.enqueueFinal({
            requestId: `ff${feishuKey(`${r.id}:${path}`)}`,
            target: targetFor(r),
            messages: [msg],
            laneKey: r.chatId,
          });
        else await notice(targetFor(r), "文件发送失败", r.chatId);
      } finally {
        controller.abort();
      }
    }
    function context(message: FeishuMessage, identity: FeishuIdentityContext): FeishuRequestRecord {
      const key = feishuBindingKey(message.chatType, message.chatId, message.threadId) ?? "group-root";
      const binding = state.bindings.get(key),
        id = feishuBatchIdentity([message.messageId]);
      return {
        ...id,
        state: "received",
        createdAt: clock.now(),
        stateAt: clock.now(),
        sessionId: binding?.sessionId ?? NEW_SESSION,
        bindingKey: key,
        bindingRev: binding?.rev ?? 0,
        senderDisplay: message.senderDisplay,
        chatLabel: message.chatLabel,
        chatId: message.chatId,
        chatType: message.chatType,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        triggerMessageId: message.messageId,
        textDigest: feishuDigest(message.text),
        ...identity,
        ...(message.createdAt !== undefined ? { sourceCreatedAt: message.createdAt } : {}),
      };
    }
    async function routerIntent(intent: FeishuRouterIntent) {
      if (!active) return;
      const m = intent.message,
        target = targetFor({ chatType: m.chatType, threadId: m.threadId, triggerMessageId: m.messageId });
      if (intent.type === "notice")
        await notice(
          target,
          (
            {
              help: `${intent.unknownCommand ? `未知命令 ${intent.unknownCommand}\n\n` : ""}${HELP_TEXT}`,
              "use-topic": "请在话题内 @ 机器人",
              "no-session-bound": "尚未绑定会话 — /list 后 /use",
              "queue-full": "队列已满，请稍后重发",
            } as Record<string, string>
          )[intent.code] ?? intent.code,
          m.chatId,
          `route-${m.eventId}`,
        );
      else if (intent.type === "list")
        await sessionCard.sendList({ message: m, generation: intent.generation, rows: intent.rows, target });
      else if (intent.type === "current") {
        const binding = intent.binding;
        if (!binding?.sessionId) {
          await notice(target, "尚未绑定会话", m.chatId);
          return;
        }
        const resolution = sessions.resolve(binding.sessionId);
        if (resolution.ok) await notice(target, `当前：${label(binding.sessionId)}`, m.chatId);
        else {
          const managed = deps.spawn?.supervisor
            .records()
            .find((record) => record.sessionId === binding.sessionId && isTerminalSpawnState(record.state));
          const install = installation(),
            tenantKey = state.tenant.get();
          if (managed && deps.spawn?.restore && deps.spawn.relaunch && install && tenantKey) {
            const r = context(m, { installGen: install.gen, tenantKey, senderOpenId: m.senderOpenId });
            await actionCard(
              r,
              `${label(binding.sessionId)}: offline`,
              "relaunch",
              JSON.stringify({
                spawnId: managed.spawnId,
                bindingKey: binding.key,
                rev: binding.rev,
                sessionId: binding.sessionId,
              }),
              "Relaunch",
            );
          } else await notice(target, `${label(binding.sessionId)}: offline — /new <same dir> 或 /list`, m.chatId);
        }
      } else if (intent.type === "bound") await notice(target, `已绑定：${label(intent.binding.sessionId!)}`, m.chatId);
      else if (intent.type === "file") await explicitFile(context(m, intent.identity), intent.path, intent.identity);
      else if (intent.type === "new") await fresh(intent);
      else if (intent.type === "open-topic") {
        const result = await sendCard(
          `ft${feishuKey(m.messageId)}`,
          { scope: "group-root", messageId: m.messageId, inThread: true },
          simpleCard("话题已建立。请在话题内 @ 机器人使用 /new <dir> 或 /use <id> 绑定会话。未绑定前不会运行 agent。"),
          m.chatId,
        );
        if (result?.threadId && active && admission.authorize(intent.identity).ok) {
          // Main-session ruling: NEVER pull the p2p current pointer (or an arbitrary sole session) into a group.
          state.bindings.set(feishuBindingKey("group", m.chatId, result.threadId)!, {
            chatId: m.chatId,
            chatType: "group",
            threadId: result.threadId,
          });
          await state.commit();
        }
      }
    }
    const spawnIdempotency = createSpawnIdempotency(clock.now);
    async function fresh(intent: Extract<FeishuRouterIntent, { type: "new" }>, confirmed = false, expectCwd?: string) {
      if (!deps.spawn || !admission.authorize(intent.identity).ok) {
        await notice(
          targetFor({
            chatType: intent.message.chatType,
            threadId: intent.message.threadId,
            triggerMessageId: intent.message.messageId,
          }),
          "/new 不可用（spawn 未启用或身份失效）",
          intent.message.chatId,
        );
        return;
      }
      const r = context(intent.message, intent.identity),
        body = JSON.stringify({ cwd: intent.cwd, firstPrompt: intent.firstPrompt });
      // Persist execution ownership before F5 can fork. Boot NEVER re-forks this marker.
      if (!state.requests.get(r.id)) {
        const { state: _state, stateAt: _at, createdAt: _created, ...input } = r;
        const added = state.requests.receive({
          ...input,
          sessionId: NEW_SESSION,
          payload: { body, messageIds: [intent.message.messageId], uploadIds: [] },
        });
        if (!added.ok) {
          await notice(targetFor(r), "队列已满，请稍后重发", r.chatId);
          return;
        }
      }
      const existing = state.requests.get(r.id)!;
      if (existing.state !== "received" && existing.state !== "dispatching") return;
      if (existing.state === "received") state.requests.transition(r.id, "dispatching");
      if (!(await state.commit()) || !active) return;
      const p = `feishu:${intent.identity.installGen}:${intent.identity.senderOpenId}`,
        origin = { listener: "lan" as const, ip: "feishu", user: p, reqId: r.id };
      const input: FreshSpawnIntent = {
        id: r.id,
        cwd: intent.cwd,
        confirmed,
        expectCwd,
        model: undefined,
        firstPrompt: undefined,
      };
      // First message is dispatched through F6 only AFTER live session binding, preserving tokens/admission.
      let outcome;
      try {
        outcome = await bounded(
          startFresh(input, {
            ...deps.spawn,
            principal: p,
            owner: { listener: "lan", user: p, reqId: r.id },
            origin,
            policy: intent.policy,
            rate: { bucket: `${p}:spawn`, capacity: 10, refillMs: 6_000, onReject: () => log("spawn", "rate") },
            limit: deps.limit,
            idempotency: spawnIdempotency,
            now: clock.now,
            deadline: createReqDeadline(clock.now, 8_000),
            reauthorize: async () =>
              admission.authorize(intent.identity).ok && active ? { ok: true } : { ok: false, code: "E_FSB_STATE" },
            audit: (record) => log("spawn", record.phase),
          }),
          8_000,
          clock,
        );
      } catch {
        if (active) {
          state.requests.transition(r.id, "uncertain", { code: "spawn-uncertain" });
          await state.commit();
          await notice(targetFor(r), "创建结果未确认，请 /list 查看；首条消息未自动重发。", r.chatId);
        }
        return;
      }
      if (!active) return;
      if (outcome.kind === "confirm") {
        if (intent.policy.scope === "known") {
          state.requests.transition(r.id, "rejected", { code: "unknown-dir" });
          await state.commit();
          await notice(
            targetFor(r),
            "该目录不在已知目录中：先在终端/网页打开过它，或把 feishuBot.spawnScope 设为 roots",
            r.chatId,
          );
          return;
        }
        // Nonce target cap 512B is intentional: large paths/forms fall back to local/web creation.
        await actionCard(
          r,
          `创建会话：${outcome.resolvedCwd}`,
          "new",
          JSON.stringify({ request: r.id, cwd: outcome.resolvedCwd }),
          "创建",
        );
      } else if (outcome.kind === "accepted") {
        state.requests.transition(r.id, "accepted", { code: `spawn:${outcome.value.spawnId}` });
        await state.commit();
        await bindFresh();
      } else {
        state.requests.transition(r.id, "rejected", { code: outcome.code });
        await state.commit();
        await notice(
          targetFor(r),
          intent.policy.scope === "known"
            ? "该目录不在已知目录中：先在终端/网页打开过它，或把 feishuBot.spawnScope 设为 roots"
            : `创建失败：${outcome.code}`,
          r.chatId,
        );
      }
    }
    async function bindFresh() {
      if (!deps.spawn || !active) return;
      for (const r of state.requests
        .list({ states: ["accepted"] })
        .filter((r) => r.sessionId === NEW_SESSION && r.code?.startsWith("spawn:"))) {
        const record = deps.spawn.lookup(r.code!.slice(6));
        if (record?.terminal || clock.now() - r.stateAt >= 60_000) {
          state.requests.transition(r.id, "reply-failed", {
            code: record?.terminal ? "spawn-failed" : "spawn-timeout",
          });
          await state.commit();
          await notice(
            targetFor(r),
            "新会话启动失败或超时，首条消息已关闭，请 /list 核实后重发。",
            r.chatId,
            `${r.id}-spawn-failed`,
          );
          continue;
        }
        if (
          !record?.agentKey ||
          !record.sessionId ||
          !admission.authorize({ installGen: r.installGen!, tenantKey: r.tenantKey!, senderOpenId: r.senderOpenId }).ok
        )
          continue;
        const currentBinding = state.bindings.get(r.bindingKey);
        if ((currentBinding?.rev ?? 0) !== r.bindingRev) {
          state.requests.transition(r.id, "unattributed", { code: "binding-changed" });
          await state.commit();
          continue;
        }
        let first = "";
        try {
          first = String(object(JSON.parse(r.payload?.body ?? "{}"))?.["firstPrompt"] ?? "");
        } catch {
          /* no initial prompt */
        }
        const skippedOnBoot = bootFresh.has(r.id) && !!first.trim();
        if (bootFresh.has(r.id)) first = "";
        const binding = state.bindings.set(r.bindingKey, {
          sessionId: record.sessionId,
          chatId: r.chatId,
          chatType: r.chatType,
          ...(r.threadId ? { threadId: r.threadId } : {}),
          offline: null,
        });
        if (!binding.ok) continue;
        // Atomic durable ownership transfer: bind + close spawn receipt + receive first prompt in one commit.
        const received = first.trim()
          ? requests.receive({
              ...r,
              sessionId: record.sessionId,
              bindingRev: binding.value.rev,
              payload: { body: first, messageIds: [`new:${r.id}`], uploadIds: [] },
              sourceCreatedAt: clock.now(),
            })
          : undefined;
        if (received?.ok) state.requests.patch(received.value.id, { code: "new-first" });
        state.requests.transition(r.id, "replied");
        if (!(await state.commit()) || !active) continue;
        await notice(
          targetFor(r),
          `已创建并绑定：${label(record.sessionId)}${skippedOnBoot ? "；hub 已重启，首条消息未自动发送，请重发" : ""}${first.trim() && !received?.ok ? "；首条消息无法排队，请重发" : ""}`,
          r.chatId,
        );
        if (received?.ok) requests.release(received.value.id);
      }
    }
    async function inboundIntent(intent: FeishuInboundIntent) {
      if (!active) return;
      if (intent.type === "approval-request") {
        const sent = await sendCard(
          `fp${feishuKey(`${intent.installGen}:${intent.senderOpenId}`)}`,
          { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: intent.ownerOpenId },
          simpleCard(`${intent.senderDisplay} 请求使用机器人`),
          intent.ownerOpenId,
        );
        if (!sent?.chatId || !active) return;
        const n = await inbound.attachApproval({ ...intent, chatId: sent.chatId, messageId: sent.messageId });
        if (n.ok)
          await patch(
            sent.messageId,
            simpleCard(`${intent.senderDisplay} 请求使用机器人`, [
              { label: "允许", n: n.allow.n },
              { label: "忽略", n: n.ignore.n },
            ]),
          );
      } else if (intent.type === "approval-decided") {
        await patch(intent.messageId, simpleCard(intent.allowed ? "已允许" : "已忽略"));
      } else {
        capability("cardCallback", true);
        const { record, identity, eventId, action } = intent;
        if (record.action === "login-approve" || record.action === "login-deny") {
          // §5.7 callback: the nonce is already redeemed by inbound's chain; E rechecks install +
          // owner + sibling nonce, then notifies the core. Ignored unless the challenge is live.
          const parsed = parseApprovalTarget(record.target);
          if (parsed !== undefined) {
            const install = installation();
            if (install?.active) {
              approval.onDecision({
                challengeId: parsed.challengeId,
                allowed: record.action === "login-approve",
                gen: parsed.gen,
                operatorOpenId: identity.senderOpenId,
                installGen: install.gen,
              });
            }
          }
        } else if (record.action === "dialog") await dialogs.callback(record, identity, eventId, action);
        else if (record.action === "resend") {
          const result = requests.resend(record.target, eventId, identity);
          if (result.ok && (await state.commit())) requests.release(result.value.id);
        } else if (record.action === "file") {
          let value: Record<string, unknown> | undefined;
          try {
            value = object(JSON.parse(record.target));
          } catch {
            return;
          }
          const request = typeof value?.["request"] === "string" ? state.requests.get(value["request"]) : undefined;
          if (request && typeof value?.["path"] === "string") await explicitFile(request, value["path"], identity);
        } else if (record.action === "relaunch") {
          let value: Record<string, unknown> | undefined;
          try {
            value = object(JSON.parse(record.target));
          } catch {
            return;
          }
          const binding =
            typeof value?.["bindingKey"] === "string" ? state.bindings.get(value["bindingKey"]) : undefined;
          if (
            !binding ||
            binding.rev !== value?.["rev"] ||
            binding.sessionId !== value?.["sessionId"] ||
            !deps.spawn?.restore ||
            !deps.spawn.relaunch ||
            typeof value?.["spawnId"] !== "string" ||
            !admission.authorize(identity).ok
          )
            return;
          // Last live checks and synchronous supervisor preflight share one no-await stretch.
          const result = deps.spawn.relaunch(value["spawnId"], createReqDeadline(clock.now, 8_000));
          await notice(
            binding.chatType === "group"
              ? { scope: "topic", messageId: record.messageId }
              : { scope: "p2p", via: "reply", messageId: record.messageId },
            result.ok
              ? "正在重新启动会话；启动后可继续发送"
              : `Relaunch: ${result.code}${"reason" in result ? ` (${result.reason})` : ""}`,
            binding.chatId,
          );
        } else if (record.action === "new") {
          let value: Record<string, unknown> | undefined;
          try {
            value = object(JSON.parse(record.target));
          } catch {
            return;
          }
          const request = typeof value?.["request"] === "string" ? state.requests.get(value["request"]) : undefined;
          if (!request?.payload || request.sessionId !== NEW_SESSION || typeof value?.["cwd"] !== "string") return;
          const payload = object(JSON.parse(request.payload.body));
          const message: FeishuMessage = {
            eventId,
            senderOpenId: request.senderOpenId,
            senderDisplay: request.senderDisplay,
            senderType: "user",
            tenantKey: identity.tenantKey,
            messageId: request.triggerMessageId,
            chatId: request.chatId,
            chatType: request.chatType,
            chatLabel: request.chatLabel,
            ...(request.threadId ? { threadId: request.threadId } : {}),
            createdAt: request.sourceCreatedAt,
            messageType: "text",
            content: {},
            text: "",
            mentions: [],
          };
          await fresh(
            {
              type: "new",
              message,
              identity,
              id: request.id,
              cwd: String(payload?.["cwd"] ?? ""),
              firstPrompt: String(payload?.["firstPrompt"] ?? ""),
              policy: { scope: deps.config.spawnScope, confirm: "unknown-dir" },
            },
            true,
            value["cwd"],
          );
        }
      }
    }
    const proactive = new Map<string, { text: string; failed: boolean; owned: boolean }>();
    function event(event: FeishuServiceEvent) {
      if (!active) return;
      if (event.type === "dialogs") {
        work.run(() => dialogs.reconcile(event.agentKey, event.epoch, event.open, event.closed));
        return;
      }
      if (event.type === "spawns") {
        work.run(bindFresh);
        return;
      }
      if (event.type === "status" || event.type === "fleet") return;
      if (event.type === "agent_down" || event.type === "agent_up" || event.type === "agent_stale")
        dialogs.disconnected(event.agentKey);
      if (event.type === "ev") {
        let p = proactive.get(event.agentKey);
        if (event.e.type === "agent_start") {
          if (proactive.size < 512)
            proactive.set(event.agentKey, (p = { text: "", failed: false, owned: runs.owns(event.agentKey) }));
        }
        if (p) {
          p.owned ||= runs.owns(event.agentKey);
          if (event.e.type === "message_end" && object(event.e["message"])?.["role"] === "assistant") {
            p.text = messageText(event.e["message"]).slice(0, 1_500);
            p.failed ||= object(event.e["message"])?.["stopReason"] === "error";
          }
          if (event.e.type === "agent_settled") {
            proactive.delete(event.agentKey);
            const sid = deps.sessions.views().find((v) => v.agentKey === event.agentKey && v.live)?.sessionId;
            if (sid)
              work.run(() =>
                notify.session({
                  sessionId: sid,
                  kind: p.failed ? "failed" : "done",
                  text: p.text,
                  feishuInitiated: p.owned,
                  ...(deps.idleEvidence?.(event.agentKey) ? { evidence: deps.idleEvidence!(event.agentKey)! } : {}),
                }),
              );
          }
        }
        // A local prompt that has no Feishu dialog card cannot be answered from Feishu, so it is
        // not pushed at all (user ruling 2026-10-19: "ask_user 如果不能在飞书上直接选择，就不用推送消息了").
        // Only a non-retrying compaction failure still notifies.
        if (event.e.type === "session_compact_failed" && event.e["willRetry"] !== true) {
          const sid = deps.sessions.views().find((v) => v.agentKey === event.agentKey && v.live)?.sessionId;
          if (sid)
            work.run(() =>
              notify.session({
                sessionId: sid,
                kind: "failed",
                text: "请到 web/终端查看",
                feishuInitiated: false,
              }),
            );
        }
      }
      runs.event(event);
    }
    function maintain() {
      if (!active) return;
      files.expirePins();
      work.run(() => dialogs.sweep());
      work.run(bindFresh);
      maintenance = clock.setTimeout(maintain, 30_000);
    }
    return {
      api,
      token,
      caps,
      work,
      connector,
      outbox,
      inbound,
      requests,
      files,
      notify,
      security,
      approval,
      sessionCard,
      get authFailed() {
        return authFailed;
      },
      get received() {
        return received;
      },
      get duplicates() {
        return duplicates;
      },
      async start() {
        await files.sweep();
        if (!active) return;
        // New-session receipts never get auto-forwarded or re-forked on boot.
        for (const r of state.requests
          .list({ states: ["received", "dispatching"] })
          .filter((r) => r.sessionId === NEW_SESSION))
          state.requests.transition(r.id, r.state === "received" ? "expired" : "uncertain", { code: "restart-new" });
        for (const r of state.requests.list({ states: ["received"] }).filter((r) => r.code === "new-first"))
          state.requests.transition(r.id, "expired", { code: "restart-first" });
        // bootFresh is captured before accepting any live work; its stored first prompts are never replayed.
        await state.commit();
        if (!active) return;
        outbox.start();
        unsubscribe = deps.events.subscribe(event);
        for (const r of state.requests
          .list({ states: ["accepted"] })
          .filter(
            (r) =>
              r.sessionId !== NEW_SESSION &&
              !state.outbox.list().some((part) => part.kind === "final" && part.requestId === r.id),
          ))
          replies.run(async () => {
            await reaction(r, false);
            await finishRun({ request: r, kind: "unattributed", text: "", truncated: false, continued: false });
          });
        for (const card of state.dialogCards.list()) if (card.status === "open") dialogs.disconnected(card.agentKey);
        for (const frame of deps.events.dialogs?.() ?? [])
          work.run(() => dialogs.reconcile(frame.agentKey, frame.epoch, frame.open, frame.closed));
        work.run(() => requests.recover());
        work.run(bindFresh);
        maintain();
        // G2: card inventory/slots are adopted from persisted anchors BEFORE any event arrives — but
        // bounded: a stuck inventory (slow commit/PATCH) must never keep the bot from connecting. On
        // timeout the connector starts anyway and adoption finishes in the background; clicks on a
        // not-yet-adopted card are rebuilt lazily from its anchor (`pick` → `adoptLazy`).
        const adoption = sessionCard.start().catch(() => {});
        try {
          await bounded(adoption, deps.cardAdoptionBudgetMs ?? 3_000, clock);
        } catch {
          log("session-card", "adoption-timeout");
        }
        if (!active) return;
        connector.start();
      },
      async stop() {
        const transport = connector.stop(); // MUST be first cleanup operation, before any gate/timer teardown.
        active = false;
        unsubscribe?.();
        unsubscribe = undefined;
        clock.clearTimeout(maintenance);
        inbound.dispose();
        router.dispose();
        requests.dispose();
        dialogs.dispose();
        sessionCard.dispose();
        sessions.clear();
        runs.dispose();
        files.dispose();
        security?.dispose();
        approval.dispose();
        notify.dispose();
        budget.dispose();
        for (const w of sendWaiters.values()) {
          clock.clearTimeout(w.timer);
          w.resolve(undefined);
        }
        sendWaiters.clear();
        // Transport drains receipts/closes concurrently. It never adds its 1s+5s to the business budgets.
        // Total wall budget: group commit 1s + dispatch 2s + outbox 2s + final flush 1s = 6s.
        const shutdownUntil = clock.now() + Object.values(FEISHU_SHUTDOWN_BUDGET_MS).reduce((sum, ms) => sum + ms, 0);
        await bounded(state.commit(), FEISHU_SHUTDOWN_BUDGET_MS.groupCommit, clock).catch(() => false);
        const dispatchUntil = Math.min(shutdownUntil, clock.now() + FEISHU_SHUTDOWN_BUDGET_MS.inFlightDispatch);
        try {
          await bounded(Promise.allSettled([...commandTasks]), FEISHU_SHUTDOWN_BUDGET_MS.inFlightDispatch, clock);
        } catch {
          /* unresolved effects stay dispatching */
        }
        await Promise.all([
          work.drain(Math.max(0, dispatchUntil - clock.now())),
          replies.drain(Math.max(0, dispatchUntil - clock.now())),
          reactions.drain(Math.max(0, dispatchUntil - clock.now())),
        ]);
        await bounded(
          outbox.stop(FEISHU_SHUTDOWN_BUDGET_MS.outboxDrain),
          Math.min(FEISHU_SHUTDOWN_BUDGET_MS.outboxDrain, Math.max(0, shutdownUntil - clock.now())),
          clock,
        ).catch(() => {});
        work.close();
        replies.close();
        reactions.close();
        await bounded(
          state.flush(FEISHU_SHUTDOWN_BUDGET_MS.stateFlush),
          Math.min(FEISHU_SHUTDOWN_BUDGET_MS.stateFlush, Math.max(0, shutdownUntil - clock.now())),
          clock,
        ).catch(() => false);
        outbox.dispose();
        token.dispose();
        // dispose synchronously fences the connector even if its close promise missed the deadline.
        const closed = connector.dispose();
        await bounded(Promise.allSettled([transport, closed]), Math.max(0, shutdownUntil - clock.now()), clock).catch(
          () => {},
        );
      },
    };
  }
  async function startLoaded(expected = lifecycle) {
    if (disposed || expected !== lifecycle) return;
    running = true;
    startedAt ||= clock.now();
    const c = credentials.current();
    if (!c) {
      if (credentials.status() === "unsafe") degraded.add("credentials-unsafe");
      publish();
      return;
    }
    if (state.phase() === "unloaded") await bounded(state.load(), 2_000, clock);
    if (disposed || !running || expected !== lifecycle) return;
    if (!state.connectorMayStart()) {
      publish();
      return;
    }
    const adopted = await bounded(state.adoptInstall(c), 1_500, clock);
    if (!adopted.ok) {
      health("persist-failed");
      return;
    }
    const http = createFeishuHttp({
      apiBase: FEISHU_API_BASES[c.brand],
      clock,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      secrets: credentials.secrets,
    });
    const token = createTokenManager({ http, credentials: credentials.tokenCredentials, clock });
    const api = deps.api ?? createFeishuApi({ http, token });
    if (!c.botOpenId) {
      const bot = await bounded(api.botInfo(), 8_000, clock).catch(() => undefined);
      if (bot?.ok) await bounded(credentials.setBotOpenId(c.gen, bot.data.openId), 1_500, clock);
    }
    if (disposed || !running || expected !== lifecycle) {
      token.dispose();
      return;
    }
    runtime = buildRuntime(api, token);
    await runtime.start();
    publish();
  }
  async function start() {
    if (disposed || runtime || starting) return starting;
    const expected = ++lifecycle;
    starting = (async () => {
      if (stopping) await stopping;
      if (expected !== lifecycle || disposed) return;
      await bounded(credentials.load(), 2_000, clock);
      await startLoaded(expected);
    })()
      .catch(() => {
        health("persist-failed");
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  }
  function stopRuntime(): Promise<void> {
    lifecycle++;
    if (stopping) return stopping;
    const current = runtime;
    // current.stop calls connector.stop synchronously before the service gate changes.
    const task = current?.stop() ?? Promise.resolve();
    running = false;
    stopping = task
      .catch(() => {
        log("shutdown", "deadline");
      })
      .finally(() => {
        if (runtime === current) {
          if (current) {
            const view = current.connector.snapshot(),
              ob = current.outbox.stats();
            retired.received += current.received;
            retired.duplicates += current.duplicates;
            retired.sent += ob.sent;
            retired.failed += ob.failed;
            retired.reconnects += view.reconnects;
            if (ob.lastCode) retired.lastCode = ob.lastCode;
            for (const [key, value] of Object.entries(view.counters))
              if (key !== "in" && key !== "duplicate") retired.dropped[key] = (retired.dropped[key] ?? 0) + value;
          }
          runtime = undefined;
        }
        stopping = undefined;
        publish();
      });
    return stopping;
  }
  function stop(): Promise<void> {
    const stopped = stopRuntime(); // first cleanup action before cancelling setup
    void registration.cancel().catch(() => {});
    return stopped;
  }
  async function admin(frame: FsbReqFrame): Promise<FsbResFrame> {
    const fail = (code: string, message = "飞书机器人状态不可用") => ({
      t: "fsb_res" as const,
      rid: frame.rid,
      ok: false as const,
      code,
      message,
    });
    const ok = (
      data?: FsbInfoData | ReturnType<typeof registration.status> | { changed: boolean; count: number },
    ): FsbResFrame => ({ t: "fsb_res", rid: frame.rid, ok: true, ...(data ? { data } : {}) });
    if (disposed) return fail("E_FSB_STATE");
    if (frame.op === "info") return ok(info());
    if (frame.op === "setup_status") return ok(registration.status());
    if (frame.op === "setup_cancel") {
      await bounded(registration.cancel(), 2_000, clock).catch(() => {});
      return ok(registration.status());
    }
    if (adminBusy) return fail("E_FSB_SETUP_ACTIVE");
    adminBusy = true;
    try {
      if (frame.op === "setup_begin") {
        const result = await bounded(registration.begin(frame), 9_000, clock);
        return result.ok ? ok(result.view) : fail(refusalToFsbCode(result.refused));
      }
      if (frame.op === "reset") {
        const stopped = stopRuntime();
        await bounded(registration.fence(), 2_000, clock);
        await stopped;
        const removed = await bounded(credentials.remove(), 1_500, clock),
          destroyed = await bounded(state.destroy(), 1_500, clock);
        await bounded(rm(join(dir, "staging"), { recursive: true, force: true }), 1_000, clock);
        degraded.clear();
        connectorView = undefined;
        running = true;
        publish();
        return removed.ok && destroyed.ok ? ok(info()) : fail("E_FSB_STATE");
      }
      const c = credentials.current();
      if (!c) return fail("E_FSB_UNCONFIGURED");
      if (frame.op === "repair") {
        if (state.phase() !== "corrupt") return fail("E_FSB_STATE");
        await stop();
        const result = await bounded(state.repair(c), 2_000, clock);
        if (!result.ok) return fail("E_FSB_STATE");
        degraded.clear();
        await startLoaded();
        return ok(info());
      }
      if (!FEISHU_OPEN_ID_RE.test(frame.openId)) return fail("E_FSB_BAD_REQUEST");
      if (frame.op === "allow") {
        const result = state.allowList.add(frame.openId);
        if (!result.ok) return fail("E_FSB_CAP");
        if (!(await bounded(state.commit(), 1_500, clock))) return fail("E_FSB_STATE");
        publish();
        return ok({ changed: result.value.added, count: state.allowList.size });
      }
      const changed = state.allowList.has(frame.openId);
      if (runtime) await bounded(runtime.requests.revokeSender(frame.openId), 1_500, clock);
      else {
        state.allowList.remove(frame.openId);
        state.requests.revokeSender(frame.openId);
        state.nonces.purgeOperator(frame.openId);
        await state.commit();
      }
      runtime?.sessionCard.revokeOperator(frame.openId); // G4: silent, cancels timers/aborts IO
      publish();
      return ok({ changed, count: state.allowList.size });
    } catch {
      return fail("E_FSB_STATE");
    } finally {
      adminBusy = false;
    }
  }
  // Stable per-service approval delegate: routes to the CURRENT runtime's port (which holds the
  // live work slot / outbox / sendCard / patchCard), and answers "unavailable" while stopped.
  const approval: FeishuLoginApproval = {
    request: (c) => (runtime !== undefined ? runtime.approval.request(c) : Promise.resolve("unavailable" as const)),
    close: (challengeId, why) => runtime?.approval.close(challengeId, why),
    onDecision: (input) => runtime?.approval.onDecision(input),
    dispose: () => runtime?.approval.dispose(),
  };
  return {
    start,
    stop,
    admin,
    approval,
    snapshot: info,
    keepalive: () => credentials.status() === "loaded" || credentials.status() === "unsafe",
    dispose(): Promise<void> {
      if (disposing) return disposing;
      const stopped = stop(); // first even on startup failure/unconfigured path
      disposed = true;
      const setup = bounded(registration.dispose(), 2_000, clock).catch(() => {});
      disposing = Promise.all([stopped, setup])
        .then(() => {})
        .finally(() => {
          state.dispose();
        });
      return disposing;
    },
  };
}
export type FeishuBotService = ReturnType<typeof createFeishuBotService>;
