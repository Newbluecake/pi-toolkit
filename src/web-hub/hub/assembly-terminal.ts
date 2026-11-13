/** Enabled-only terminal composition. Missing local authority is unavailable, not
 * permission inferred from a status/card, wire booleans or an absent journal. */
import type { HubAssembly } from "./assembly.js";
import { auditTerminal } from "./audit.js";
import { TerminalResourceFence, createLocalTerminalProofVerifier } from "./terminal/resource-fence.js";
import { createTerminalResourceJournal } from "./terminal/resource-fence-journal.js";
import { createTerminalService } from "./terminal/service.js";
import { createTerminalRoutes } from "./terminal/routes.js";
import { TERMINAL_HTTP_PATHS } from "../protocol/terminal-paths.js";
import { terminalUnavailable } from "./ports.js";
import { sameTerminalMeta } from "./terminal/limits.js";
import {
  initializeTerminalStore,
  readPhysicalReceipts,
  verifyLocalReceipt,
  TerminalLocalError,
  localBounded,
} from "../protocol/terminal-local.js";
import { createTerminalLocalAuthority } from "./terminal/local-authority.js";
import type { TerminalIngressPort, TerminalResourceJournalPort } from "./ports.js";

export async function assembleTerminal(ctx: HubAssembly) {
  const config = ctx.config.terminal;
  if (config === undefined) return undefined;
  const { now, paths, log } = ctx;
  let store: Awaited<ReturnType<typeof initializeTerminalStore>> | undefined;
  let reason = "local-store-unavailable";
  try {
    store = await initializeTerminalStore(paths.stateDir);
  } catch (error) {
    reason = error instanceof TerminalLocalError ? error.reason : "local-store-unavailable";
    log.warn("web-hub terminal unavailable", { reason });
  }
  const local =
    store === undefined
      ? undefined
      : createTerminalLocalAuthority({ store, now, link: (key) => ctx.agentServer?.terminalLink?.(key) });
  const unavailable: TerminalResourceJournalPort = {
    load: async () => ({ kind: "unavailable" }),
    commit: async () => "unavailable",
  };
  const fence = new TerminalResourceFence({
    journal: store ? createTerminalResourceJournal({ stateDir: store.root, now }) : unavailable,
    now,
    verifyProof: createLocalTerminalProofVerifier({
      receipt: (proof, entry) => store !== undefined && verifyLocalReceipt(store, proof, entry),
    }),
  });
  // A crash after pruning but before ACK can leave a legitimate immutable receipt
  // with no journal row. Reinsert <=32 metadata entries as UNKNOWN/quarantined,
  // never infer consumption/forget from absence; require fresh complete OS proof.
  const retained = store ? await localBounded(() => readPhysicalReceipts(store!)) : [];
  await fence.initialize(
    ctx.startup.signal,
    retained.map(({ record }) => ({
      identity: { ...record.identity },
      agentProcessIdentity: { ...record.agentProcessIdentity },
      managed: structuredClone(record.physical.identitiesChecked),
      spawnState: "settled" as const,
      state: "closing" as const,
    })),
  );
  const target = (key: string) => local?.target(key);
  const listeners = new Set<() => void>();
  ctx.terminalPrivacyChanged = () => {
    // Service installs deny/clears writers first; then the browser sees original SSE loss.
    try {
      for (const listener of listeners) listener();
    } finally {
      service.bindings.revokeAll();
    }
  };
  const service = createTerminalService({
    config,
    now,
    resourceFence: fence,
    target,
    ...(local ? { resolveTarget: (key: string, signal: AbortSignal) => local.ensure(key, signal) } : {}),
    targets: () =>
      ctx.registry!.list().flatMap((view) => {
        const t = target(view.agentKey);
        return t ? [t] : [];
      }),
    send: (meta, frame) => {
      const link = ctx.agentServer?.terminalLink?.(meta.agentKey);
      return link !== undefined && sameTerminalMeta(meta, link.meta) && link.send(frame);
    },
    pendingBytes: (meta) => {
      const link = ctx.agentServer?.terminalLink?.(meta.agentKey);
      return link !== undefined && sameTerminalMeta(meta, link.meta) ? link.pendingBytes : Number.MAX_SAFE_INTEGER;
    },
    privacy: {
      denied: (sessionId) =>
        ctx.privacyStore === undefined || ctx.privacyStore.degraded || ctx.privacyStore.isLocked(sessionId),
      onChange: (fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    audit: (record) => auditTerminal(log, record),
  });
  const baseRoutes = createTerminalRoutes({ service, now, log });
  const routes: typeof baseRoutes = {
    ...baseRoutes,
    async handle(req, res, context, identity, signal) {
      const path = (req.url ?? "").split("?")[0];
      if (local === undefined && Object.values(TERMINAL_HTTP_PATHS).some((p) => p === path)) {
        req.resume();
        const body = JSON.stringify(terminalUnavailable());
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return true;
      }
      return baseRoutes.handle(req, res, context, identity, signal);
    },
    openSse(req, res, id, clientId, origin) {
      // Legacy privacy snapshots cannot express degraded. Use observable connection loss,
      // after the hub capability burst but before issuing any private binding material.
      if (local === undefined || ctx.privacyStore === undefined || ctx.privacyStore.degraded) {
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      baseRoutes.openSse(req, res, id, clientId, origin);
    },
  };
  const dispose = async () => {
    ctx.terminalPrivacyChanged = undefined;
    local?.dispose();
    await routes.dispose();
  };
  const ingress: TerminalIngressPort = {
    ownsCommand: (meta, raw) => (local?.port.ownsCommand(meta, raw) ?? false) || service.ingress.ownsCommand(meta, raw),
    consumeAgentFrame: (meta, raw) => {
      if (!local?.consumes(meta, raw)) service.ingress.consumeAgentFrame(meta, raw);
    },
    retireLink: (meta) => {
      local?.port.retireLink(meta);
      service.ingress.retireLink(meta);
    },
    onIngressFailure: (meta) => {
      local?.port.onIngressFailure?.(meta);
      service.ingress.onIngressFailure?.(meta);
    },
  };
  ctx.cleanup.push(dispose);
  return {
    service,
    routes,
    ingress,
    dispose,
    status: store ? { state: "ready" as const } : { state: "unavailable" as const, reason },
  };
}
