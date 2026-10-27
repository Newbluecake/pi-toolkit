import { webHubUploadsDir } from "../protocol/paths.js";
import type { HubAssembly } from "./assembly.js";
import { auditAvatar, auditUpload, createUploadHttpMetrics } from "./audit.js";
import { createAvatarRoutes } from "./avatar/routes.js";
import { createAvatarStore } from "./avatar/store.js";
import { readBody } from "./http.js";
import { createPrivacyStore } from "./privacy/store.js";
import { createReqDeadline } from "./req-deadline.js";
import { createUploadStore } from "./uploads.js";

export function assembleAvatarStore(ctx: HubAssembly) {
  const { config, paths, log, now, cleanup } = ctx;
  const registry = ctx.registry!;
  const info = ctx.info!;

  if (config.avatar === true) {
    const store = createAvatarStore({
      stateDir: paths.stateDir,
      now,
      log,
      audit: (record) => {
        const op =
          record.op === "get" || record.op === "put" || record.op === "delete" || record.op === "load"
            ? record.op
            : "load";
        const phase =
          record.phase === "request" || record.phase === "reject" || record.phase === "reconcile"
            ? record.phase
            : "request";
        auditAvatar(log, {
          reqId: op === "load" ? "load" : "store",
          op,
          phase,
          ok: record.ok === true,
          ms: typeof record.ms === "number" ? record.ms : 0,
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          ...(typeof record.v === "string" ? { v: record.v } : {}),
          ...(typeof record.gen === "number" ? { gen: record.gen } : {}),
          ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
          ...(typeof record.side === "number" ? { side: record.side } : {}),
        });
      },
      onChange: (change) => {
        // The store has its own epoch fence; this second fence covers hub shutdown.
        if (ctx.isClosing()) return;
        info.avatar = change.info;
        registry.publish({ type: "hub" });
      },
    });
    ctx.avatarRoutes = createAvatarRoutes({
      store,
      hub: () => ({ pid: info.pid, startedAt: info.startedAt }),
      readBody,
      log,
      now,
    });
    // A factory/startup failure before the frontend is built must still close the store.
    cleanup.push(() => store.close(createReqDeadline(now, ctx.stepDeadlineMs).at));
    // Avatar loading is deliberately not on the startup critical path.
    void store.load();
  }
}

export async function loadPrivacyStore(ctx: HubAssembly) {
  const { config, deps, paths, log, now, startup, cleanup, startupStep } = ctx;
  const registry = ctx.registry!;
  // web-hub-privacy plan v2.1 (P1): the privacy-lock STORE is created and loaded HERE —
  // before the spawn assembly below — because the session-history fork path
  // (`spawn/routes.ts`'s doSessionBranch) inherits a locked source session's mark onto the
  // new sessionId BEFORE the fork is launched (「先写新 sessionId 标记再 spawn」), so the
  // store must already exist by the time `createSpawnRoutes` is called. Gated on
  // `config.privacy === true` (off ⇒ no store, `privacy.json` never touched — a re-enable
  // finds every mark intact). `load()` never throws: corrupt/unreadable ⇒ renamed to .bak +
  // empty set + WARN (`degraded` is P3's `/webhub status` source). The ROUTES are assembled
  // later (right before the frontend), where every successful mutation republishes the full
  // set as the direct-send `privacy` bus event. (Declared at assembly scope above —
  // `close()` reads it before this point may ever run.)
  if (config.privacy === true) {
    ctx.privacyStore = createPrivacyStore({
      stateDir: paths.stateDir,
      log,
      onChange: (locked) => {
        // Same shutdown fence as the avatar store's onChange below.
        if (ctx.isClosing()) return;
        registry.publish({ type: "privacy", locked });
      },
    });
    await startupStep(ctx.privacyStore.load());
    // Startup-failure path: drain the store's write chain (idempotent, never throws).
    cleanup.push(() => ctx.privacyStore!.close());
  }
}

export function assembleUploads(ctx: HubAssembly) {
  const { config, deps, paths, log, now, startup, cleanup, startupStep } = ctx;

  // web-hub-upload plan §2.2/§2.6 (U3): the upload store is constructed unconditionally —
  // `webHub.uploads` gating happens through agent hello caps (§5.1), not here. Construction
  // never throws for an unusable root (the store disables itself and `begin` answers
  // `E_UPLOAD_DISABLED`); a synchronous throw (a bug, not a fs state) degrades uploads to 501
  // while the rest of the hub starts normally (plan §6 U3: "根校验失败 ⇒ 不传 store").
  try {
    ctx.uploads = createUploadStore({
      root: webHubUploadsDir(config.home),
      now,
      log,
      audit: (e) => auditUpload(log, e),
    });
  } catch (err) {
    log.error("web-hub: upload store construction failed — /api/upload/* will answer 501", {
      error: String(err),
    });
    ctx.uploads = undefined;
  }
  // §5.4 (U3 P2-2): HTTP-layer (pre-store) upload reject counters, shared by both listeners and
  // merged into the 30-min `upload stats` row below.
  const uploadMetrics = createUploadHttpMetrics();
  // §2.6 #13: pushed BEFORE the frontend's own cleanup so the startup-failure reverse-order
  // path also closes the store after the frontend stops accepting requests.
  cleanup.push(async () => {
    await ctx.uploads?.close();
  });

  return uploadMetrics;
}
