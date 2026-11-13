/** Enabled-only terminal composition. Missing local authority is unavailable, not
 * permission inferred from a status/card, wire booleans or an absent journal. */
import type { HubAssembly } from "./assembly.js";
import type { TerminalAgentLink } from "./agent-server.js";
import type { TerminalAgentTarget } from "./terminal/service.js";
import type { TerminalReapProof, TerminalResourceEntry } from "../protocol/terminal.js";
import { auditTerminal } from "./audit.js";
import { TerminalResourceFence, createLocalTerminalProofVerifier } from "./terminal/resource-fence.js";
import { createTerminalResourceJournal } from "./terminal/resource-fence-journal.js";
import { createTerminalService } from "./terminal/service.js";
import { createTerminalRoutes } from "./terminal/routes.js";
import { TERMINAL_HTTP_PATHS } from "../protocol/terminal-paths.js";
import { terminalUnavailable } from "./ports.js";
import { TerminalFault, sameTerminalMeta } from "./terminal/limits.js";

/** Local producer authority, never an HTTP/settings/Feishu input. */
export interface TerminalLocalAuthority {
  target(link: TerminalAgentLink): TerminalAgentTarget | undefined;
  receipt(proof: TerminalReapProof, entry: TerminalResourceEntry): boolean;
}
export async function assembleTerminal(ctx: HubAssembly, authority?: TerminalLocalAuthority) {
  const config = ctx.config.terminal;
  if (config === undefined) return undefined;
  const { now, paths, log } = ctx;
  const fence = new TerminalResourceFence({
    journal: createTerminalResourceJournal({ stateDir: paths.stateDir, now }),
    now,
    verifyProof: createLocalTerminalProofVerifier({
      receipt: (proof, entry) => {
        if (authority === undefined) throw new TerminalFault("E_UNAVAILABLE");
        return authority.receipt(proof, entry);
      },
    }),
  });
  await fence.initialize(ctx.startup.signal);
  const target = (key: string) => {
    const link = ctx.agentServer?.terminalLink?.(key);
    if (link === undefined || authority === undefined) return undefined;
    const current = authority.target(link);
    return current !== undefined && sameTerminalMeta(current.meta, link.meta) ? current : undefined;
  };
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
      if (authority === undefined && Object.values(TERMINAL_HTTP_PATHS).some((p) => p === path)) {
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
      if (authority === undefined || ctx.privacyStore === undefined || ctx.privacyStore.degraded) {
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      baseRoutes.openSse(req, res, id, clientId, origin);
    },
  };
  const dispose = async () => {
    ctx.terminalPrivacyChanged = undefined;
    await routes.dispose();
  };
  ctx.cleanup.push(dispose);
  return { service, routes, dispose };
}
