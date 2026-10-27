import { recoverRotateIntent } from "./admin.js";
import { syncSpawnStatus } from "./assembly-spawn.js";
import type { HttpFrontendExt, HubAssembly, LanFacadeExt } from "./assembly.js";
import type { createUploadHttpMetrics } from "./audit.js";
import { uploadStatsFields } from "./audit.js";
import { type HubRecord } from "./hub-json.js";
import { createIdleMonitor } from "./idle.js";
import { type LanStore } from "./lan-store.js";
import { startFence } from "./singleton.js";
import { createSupersede, SUPERSEDE_YIELD_MS } from "./supersede.js";
/** web-hub-upload plan §2.6 (U3): committed-file TTL sweep + `upload stats` aggregate row cadence. */
const UPLOAD_SWEEP_TICK_MS = 30 * 60_000;
/** §2.6: idle in-flight invalidation (10 min idle TTL) + dirty `referencedAt` flush retry cadence. */
const UPLOAD_INFLIGHT_TICK_MS = 60_000;

/** Supersede and rotate-intent observers retain their original pre-listen phase. */
export function assembleSupersede(ctx: HubAssembly): void {
  const { config, paths, log, now, cleanup } = ctx;
  const registry = ctx.registry!;
  const info = ctx.info!;
  const hubJson = ctx.hubJson!;
  const commandRouter = ctx.commandRouter!;
  // C10: assemble version replacement after the command router and frontend exist.
  // The socket can already accept hello; tests hold ui.refresh below to exercise early close.
  // Cancel handles for in-flight acc32-B9 dialogs-handshake waits — drained on close/dispose
  // so a pending one-shot bus subscription never outlives the hub.
  ctx.supersede = createSupersede({
    hubVersion: config.pluginVersion,
    now,
    ...(paths.stoppedFile === undefined ? {} : { stopFile: paths.stoppedFile }),
    openDialogs: () =>
      registry.list().flatMap((a) => {
        const dialogs = a.dialogs as { open?: unknown[] } | null | undefined;
        const count = dialogs?.open?.length ?? 0;
        return count === 0 ? [] : [{ agentKey: a.agentKey, count }];
      }),
    inflight: () => commandRouter.inflight(),
    kdfInflight: () => ctx.kdfInFlight,
    // web-hub-spawn plan §SP10 (arch §7.8): quiet also requires zero busy managed spawns —
    // replacing the hub under a busy web-spawned agent ends that session with the stdin EOF.
    // SP13（SP10 验收遗留评估）：busy 分量并入首条消息在途/退避重发计数（`sending` 状态）——
    // 一条尚未送达的首条消息同样会被 hub 替换的 stdin EOF 打断，绝不计为 quiet。
    managedBusy: () => (ctx.spawnSup?.busyCount() ?? 0) + (ctx.firstPromptFwd?.sendingCount() ?? 0),
    // acc32-B9: a reliable handshake for the first quiet judgment after a hello — resolve
    // immediately if the registry already has *any* dialogs snapshot for this agent (a
    // reclaimed/reconnected Rec whose `dialogs` field survived the reconnect, §registry.ts
    // `register()`'s reclaim branch never touches it), otherwise wait for the one-shot
    // `dialogs` bus event for this exact `agentKey` or the bounded timeout, whichever is first.
    awaitDialogsSlot: (agentKey, timeoutMs) => {
      if (registry.get(agentKey)?.dialogs !== undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          ctx.supersedeWaitCancels.delete(finish);
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        // Registered so hub close/dispose can cancel a still-pending handshake wait
        // immediately instead of leaking the bus subscription until the timeout fires.
        ctx.supersedeWaitCancels.add(finish);
        const unsubscribe = registry.bus.subscribe((e) => {
          if (e.type === "dialogs" && e.agentKey === agentKey) finish();
        });
        const timer = setTimeout(finish, timeoutMs);
        timer.unref();
      });
    },
    stateChanged: (s) => {
      if (s === undefined) {
        delete info.state;
        delete info.nextVersion;
        info.supersedePending = false;
        delete info.supersedeDeadlineAt;
        delete info.forced;
        delete info.draining;
        delete info.supersedeBlocked;
      } else {
        info.supersedePending = true;
        info.nextVersion = s.nextVersion;
        info.supersedeDeadlineAt = s.deadlineAt;
        if (s.forced === true) info.forced = true;
        if (s.blocked !== undefined) info.supersedeBlocked = s.blocked;
        else delete info.supersedeBlocked;
      }
    },
    audit: (op, fields) => log.info("web-hub admin op", { audit: "admin", op, ...fields }),
    log,
    restart: async ({ nextVersion, forced, openDialogs, inflightAtDrain }) => {
      if (ctx.bot !== undefined) await ctx.stopBot(); // also precedes forced command-router drain.
      info.state = "restarting";
      info.nextVersion = nextVersion;
      info.supersedePending = true;
      info.forced = forced;
      info.draining = forced;
      if (forced) {
        const drained = await commandRouter.drain();
        info.draining = false;
        // §6.7.3's audit row carries `drainTimedOut` — folded into the SAME tagged audit
        // channel (`audit:"admin"`), emitted here because the controller's begin()-time audit
        // necessarily precedes the drain (C10 verifier finding).
        log.info("web-hub admin op", {
          audit: "admin",
          op: "supersede",
          phase: "drain",
          nextVersion,
          forced,
          inflightAtDrain,
          drainTimedOut: drained.timedOut,
          inflight: drained.inflight,
        });
      }
      const openByAgent = new Map(openDialogs.map((x) => [x.agentKey, x.count]));
      registry.broadcast((agentKey) => {
        const count = openByAgent.get(agentKey) ?? 0;
        return {
          t: "superseded",
          nextVersion,
          yieldMs: SUPERSEDE_YIELD_MS,
          ...(forced ? { forced: true as const } : {}),
          ...(count > 0 ? { openDialogs: count } : {}),
        };
      });
      await ctx.close!("superseded");
    },
  });
  ctx.supersedeTimer = setInterval(() => ctx.supersede?.tick(), 250);
  ctx.supersedeTimer.unref();
  // acc32-B9 defense in depth: re-check quiet immediately whenever a `dialogs` slot changes
  // (a dialog opening OR closing), rather than relying solely on the 250ms periodic tick —
  // this is on top of (not instead of) `observe()`'s own deferred first check above.
  ctx.unsubscribeSupersedeOnDialogs = registry.bus.subscribe((e) => {
    if (e.type === "dialogs") ctx.supersede?.tick();
  });
  cleanup.push(async () => {
    ctx.unsubscribeSupersedeOnDialogs();
    if (ctx.supersedeTimer !== undefined) clearInterval(ctx.supersedeTimer);
    for (const cancel of [...ctx.supersedeWaitCancels]) cancel();
    ctx.supersede?.dispose();
  });
  const scanRotateIntent = async (): Promise<void> => {
    if (ctx.isClosing()) return;
    const revokeLan =
      ctx.lanDeps === undefined
        ? undefined
        : async (): Promise<number> => (await (ctx.lanDeps!.store as Partial<LanStore>).revokeAllSessions?.()) ?? 0;
    const outcome = await recoverRotateIntent({
      paths: {
        tokenFile: paths.tokenFile,
        rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
      },
      log,
      // acc32-B7: same fix as the startup pass above — `hasLan` must not fold in whether LAN
      // assembly ever succeeded (`lanDeps !== undefined`); a still-unopened store still needs
      // `revokeLan === undefined` to reach `recoverRotateIntent`'s own fail-closed branch rather
      // than being masked as "no LAN configured".
      hasLan: config.lan !== undefined,
      ...(revokeLan === undefined ? {} : { revokeLan }),
      now,
      audit: (fields) => log.info("web-hub admin op", { audit: "admin", op: "rotate_token", ...fields }),
    });
    if (ctx.isClosing() || !outcome.recovered) return;
    (ctx.fe as HttpFrontendExt).auth?.reload();
    (ctx.fe as HttpFrontendExt).revokeAllSse?.();
    if (outcome.lanBlocked === true) {
      ctx.lanBlockedByRotate = true;
      if (ctx.fe.lan !== undefined) {
        ctx.lanClosedByRotateScan = true;
        log.warn(
          "web-hub: closing the LAN listener (rotate revoke failed); run /webhub restart to re-open it once the pending rotate completes",
        );
        void ctx.fe.lan
          .close()
          .catch((err: unknown) =>
            log.error("web-hub: failed to close LAN listener after rotate revoke failure", { error: String(err) }),
          );
      }
      hubJson.patchLan({ state: "off", reason: "rotate-pending" });
      return;
    }
    if (ctx.fe.lan !== undefined) {
      (ctx.fe.lan as LanFacadeExt | undefined)?.revokeAll?.();
      (ctx.fe as HttpFrontendExt).bumpLanRevokeGen?.();
    }
    if (ctx.lanBlockedByRotate && ctx.fe.lan !== undefined && !ctx.lanClosedByRotateScan) {
      ctx.lanBlockedByRotate = false;
      void ctx.fe.lan.start().then(
        (s) => hubJson.patchLan(s),
        (err: unknown) =>
          log.error("web-hub: LAN start() (post rotate-pending recovery) rejected unexpectedly", {
            error: String(err),
          }),
      );
    }
  };
  ctx.scanRotateIntent = scanRotateIntent;
  ctx.recoverRotateOnHello = () => {
    void scanRotateIntent().catch((err: unknown) =>
      log.error("web-hub: hello rotate-intent scan failed", { error: String(err) }),
    );
  };
}

export function proxyStatusOf(ctx: HubAssembly): HubRecord["proxy"] | undefined {
  const st = ctx.proxyService?.status?.();
  return st === undefined ? undefined : { portsStore: st.portsStore };
}

/** Post-publication timers/fence/idle registration, in unchanged order. */
export function startRuntimeMonitors(
  ctx: HubAssembly,
  uploadMetrics: ReturnType<typeof createUploadHttpMetrics>,
): void {
  const { config, paths, log, now } = ctx;
  const registry = ctx.registry!;
  const hubJson = ctx.hubJson!;
  ctx.tick = setInterval(() => {
    try {
      registry.tick(now());
    } catch (err) {
      log.error("registry tick threw", { error: String(err) });
    }
    // web-hub-spawn plan §SP10: ride the same 5s tick to re-sync hub.json's `spawn` summary
    // (pure in-memory compare; the file is only rewritten when the value actually changed).
    syncSpawnStatus(ctx);
    // web-hub-proxy (X1c): a runtime persist failure latches the ports store `broken`; mirror it
    // into hub.json (pure in-memory compare, rewritten only on a real change).
    const proxySt = proxyStatusOf(ctx);
    if (proxySt !== undefined && proxySt.portsStore !== ctx.lastProxyPortsStore) {
      const cur = hubJson.current();
      if (cur !== undefined) {
        ctx.lastProxyPortsStore = proxySt.portsStore;
        hubJson.write({ ...cur, proxy: proxySt });
      }
    }
  }, ctx.registryTickMs);
  ctx.tick.unref();

  // \u00a76.7.1 (C8) "hub \u8fd0\u884c\u671f" row: every `ctx.rotateScanMs` (unref), re-run the same
  // recovery helper against whatever is on disk right now \u2014 catches an intent this hub process
  // didn't itself create (the offline agent path, or another hub racing this one), and retries a
  // previously-`lanBlocked` revoke once the LAN store is healthy again. NOTE (delivery report):
  // The same recovery helper is also invoked by agent-server.ts on every
  // successful hello; this timer covers offline rotations and quiet periods.
  ctx.rotateScan = setInterval(() => {
    void ctx.scanRotateIntent!().catch((err: unknown) =>
      log.error("web-hub: periodic rotate-intent scan failed", { error: String(err) }),
    );
  }, ctx.rotateScanMs);
  ctx.rotateScan.unref();

  // web-hub-upload plan §2.6 (U3): upload lifecycle ticks (both unref'd). The 60s tick covers
  // idle in-flight invalidation (10 min TTL) and retries dirty `referencedAt` persistence
  // (sweep() always flushes dirty references first); the 30-min tick additionally writes the
  // §5.4 `upload stats` aggregate row. `sweep("tick")`'s committed-file TTL eviction is
  // exact-time based, so running it at both cadences changes nothing semantically.
  ctx.uploadInflightTick =
    ctx.uploads === undefined
      ? undefined
      : setInterval(() => {
          void ctx
            .uploads!.sweep("tick")
            .catch((err: unknown) => log.error("web-hub: upload sweep tick failed", { error: String(err) }));
        }, UPLOAD_INFLIGHT_TICK_MS);
  ctx.uploadInflightTick?.unref();
  ctx.uploadSweepTick =
    ctx.uploads === undefined
      ? undefined
      : setInterval(() => {
          void ctx
            .uploads!.sweep("tick")
            .then(() => {
              log.info("upload stats", {
                audit: "upload-stats",
                ...uploadStatsFields(ctx.uploads!.stats(), uploadMetrics.snapshot()),
              });
            })
            .catch((err: unknown) => log.error("web-hub: upload sweep tick failed", { error: String(err) }));
        }, UPLOAD_SWEEP_TICK_MS);
  ctx.uploadSweepTick?.unref();

  ctx.stopFence = startFence(paths.socketPath, ctx.socketIdentity!, (why) => {
    log.warn("socket fence lost: another hub owns the socket path", { why });
    void ctx.close!("fence");
  });

  ctx.idle = createIdleMonitor({
    counts: () => ({
      agents: Math.max(ctx.agentServer?.connectionCount() ?? 0, registry.list().length),
      // web-hub-proxy §3.4 (X1c): a working proxy tab (open sockets) keeps the hub alive.
      sse: ctx.fe.clientCount() + (ctx.proxyService?.activeConnections() ?? 0),
      // web-hub-spawn plan §SP10 (arch §7.8 "idle 自退"): a live managed child keeps the
      // hub alive — the absolute lifetime deadline (§6.5 maxLifetimeMinutes) is the backstop.
      headless: ctx.spawnSup?.liveCount() ?? 0,
      ...(ctx.bot === undefined ? {} : { bot: ctx.bot.keepalive() ? 1 : 0 }),
    }),
    idleMs: Math.max(1, config.idleExitMinutes) * 60_000,
    now,
    onIdle: () => {
      log.info("idle timeout reached");
      void ctx.close!("idle");
    },
  });
}
