import { createGitRunner } from "../../git/run.js";
import { webHubUploadsDir } from "../protocol/paths.js";
import type { HubAssembly } from "./assembly.js";
import { createFsAdmitter } from "./preview/admit.js";
import { createPreviewIoTracker, previewProcFdAvailable, resolvePreviewDenyContext } from "./preview/fs.js";
import { createPreviewRoutes } from "./preview/routes.js";
import { createWorktreeDiffRoutes } from "./worktree-diff/routes.js";
import { createWorktreeGraphRoutes } from "./worktree-graph/routes.js";
/** Pure extraction of the assemblePreview phase; invoked only at the original feature gate. */
export async function assemblePreview(ctx: HubAssembly): Promise<void> {
  const { config, deps, log, now, startup, startupStep } = ctx;
  const registry = ctx.registry!;
  const htmlEnabled = ctx.htmlEnabled;
  const hubAgentDir = ctx.hubAgentDir;
  // web-hub-preview plan v3 §4.5/§6 (PV3): the preview route frontend — constructed only when
  // `config.preview` exists (PV1: mode "off" is the key's ABSENCE, so the cap declaration and
  // this construction read the same config key and can never disagree). Pure closure
  // building: no fs, no I/O, nothing that can fail. The limiter is deliberately NOT passed —
  // `createPreviewRoutes` defaults to its own private `CmdLimit` (§7-D14: preview bucket
  // churn must never evict the cmd/upload lines' buckets).
  //
  // dir-plan v3.1 §2.6 (P1a): BEFORE the routes are built, home/agentDir are resolved to
  // their literal+canonical forms (each may itself be a symlink; under global admission a
  // literal-only deny context would miss every canonical-path request). The resolution is
  // tracked by its OWN startup tracker (never the request instance, §2.4's parameter-flow
  // table), bounded at 2 s, and NEVER fails the hub — a degraded member keeps its literal
  // form + a path-free WARN, backstopped by the §2.3 global twins. agentDir shares the
  // spawn assembly's exact source (L512's SP3): `PI_CODING_AGENT_DIR ?? ${home}/.pi/agent`.
  if (config.preview !== undefined) {
    // spawn-dirmkdir: reuse the spawn assembly's resolution when it already ran (spawn on);
    // otherwise resolve here exactly as before (spawn-off + preview-on stays byte-identical).
    const denyCtx =
      ctx.previewDenyCtx ??
      (await startupStep(
        resolvePreviewDenyContext(
          { home: config.home, agentDir: hubAgentDir },
          {
            tracker: createPreviewIoTracker(),
            now,
            log,
            signal: startup.signal,
          },
        ),
      ));
    startup.signal.throwIfAborted();
    ctx.previewDenyCtx = denyCtx;
    const sharedPreview =
      config.feishuBot === undefined
        ? undefined
        : (() => {
            const tracker = createPreviewIoTracker();
            ctx.botPreview = createFsAdmitter({ denyCtx, tracker, log, now });
            return { tracker, admitter: ctx.botPreview };
          })();
    ctx.previewRoutes = createPreviewRoutes({
      mode: config.preview,
      denyCtx,
      ...sharedPreview,
      uploadsRoot: webHubUploadsDir(config.home),
      registry,
      ...(ctx.uploads === undefined
        ? {}
        : {
            uploads: {
              openForPreview: (p, requestCtx) => ctx.uploads!.openForPreview(p, requestCtx),
            },
          }),
      log,
      now,
      // web-hub-html-preview plan v2 §4: the HTML surface (mint/serve/wrapper/revoke) is
      // attached only under `htmlEnabled`; absent ⇒ every existing route is byte-identical.
      ...(htmlEnabled ? { html: {} } : {}),
    });
    // dir-plan v3.1 §2.9 (P1a): ONE stable WARN per hub process when preview runs as root —
    // OS permission checks no longer bound what preview could read, only the denylist does
    // (the §2.7 boundary). Only `event` and `mode` ride the line — never a path or username.
    // `/webhub restart` produces a new process, which warns again by design.
    const uid = deps.getuid?.() ?? process.getuid?.();
    if (uid === 0) {
      log.warn(
        "web-hub preview: hub is running as root — OS permission checks no longer limit preview; only the denylist applies",
        { event: "preview.root_uid", mode: config.preview },
      );
    }
    // worktree-diff plan §1.6 (D3): the worktree-diff route frontend — same feature gate as
    // preview (`config.preview` exists) PLUS the /proc probe (D21: the three-fd pin is
    // /proc-bound; without /proc the routes are never built and `wtdiff.v1` never declared —
    // loopback AND LAN both fall back to the not-enabled matrix byte-identically). Shares the
    // SAME denyCtx object preview just resolved (§2.5) and takes the hub-side git runner
    // (D15). Pure closure building — nothing here can fail.
    if (previewProcFdAvailable()) {
      const graphGitRunner = deps.gitRunner ?? createGitRunner();
      ctx.worktreeDiffRoutes = createWorktreeDiffRoutes({
        mode: config.preview,
        denyCtx,
        registry,
        run: graphGitRunner,
        log,
        now,
      });
      // worktree-graph plan v2 §2.6 (P2): the commit-graph route frontend — the SAME feature
      // gate as wtdiff above (「与 wtdiff 同门」, §3), the SAME denyCtx AND the SAME hub-side git
      // runner (D15 precedent — one runner, two route frontends).
      ctx.worktreeGraphRoutes = createWorktreeGraphRoutes({
        mode: config.preview,
        denyCtx,
        registry,
        run: graphGitRunner,
        log,
        now,
        // routes are only built when the /proc probe passed ⇒ exactly when the cap is declared
        mergedEnabled: true,
      });
    }
  }
}
