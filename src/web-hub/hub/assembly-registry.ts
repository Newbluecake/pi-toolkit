import { AGENT_NOSPAWN_CAP } from "../protocol/nospawn.js";
import type { HubAssembly } from "./assembly.js";
import { createHistoryService } from "./history.js";
import { createRegistry } from "./registry.js";
import { createRunFileReader } from "./run-file-reader.js";
import { createRunTranscriptService } from "./run-transcript.js";

export function assembleRegistry(ctx: HubAssembly) {
  const { config, log, now, cleanup } = ctx;
  const botDialogSlots = ctx.botDialogSlots;
  const registry = createRegistry({
    now,
    log,
    hubVersion: config.pluginVersion,
    // web-hub-spawn plan §SP10 (arch §4.3 “版本观察”): a MANAGED agent's plugin version never
    // reaches `supersede.observe` — a hub-spawned agent that merely loaded a newer pi-toolkit
    // (settings.json pointing at a newer package) would otherwise trigger a hub version
    // replacement that ends its own session with the stdin EOF; it only records a
    // `hint:"newer-plugin"` on the spawn record instead.
    onVersion: (pluginVersion, agentKey) => {
      botDialogSlots?.delete(agentKey);
      ctx.botOnHello?.(agentKey); // EVERY reconnect, even same epoch/caps, breaks attribution proof.
      if (ctx.spawnSup?.isManaged(agentKey) === true) {
        ctx.spawnSup.noteVersion(agentKey, pluginVersion);
        return;
      }
      // private-plan §4.1-5 (Q2): an agent advertising agent.nospawn.v1 (a private-mount-ns
      // session) never enters the version observer either — the replacement hub could only
      // be spawned from inside the ns, which spawnHub refuses. Caps are registered before
      // onVersion fires, so getCaps sees THIS hello's set (R25 covers a hub that predates
      // the cap).
      if (registry.getCaps(agentKey)?.includes(AGENT_NOSPAWN_CAP) === true) return;
      ctx.supersede?.observe(pluginVersion, agentKey);
    },
    onTick: () => ctx.supersede?.tick(),
  });
  ctx.registry = registry;
  const unsubscribeBotSlots =
    botDialogSlots === undefined
      ? () => {}
      : registry.bus.subscribe((e) => {
          if (e.type === "dialogs") botDialogSlots.set(e.agentKey, e);
          else if (e.type === "agent_down" || e.type === "agent_stale") botDialogSlots.delete(e.agentKey);
        });
  cleanup.push(async () => unsubscribeBotSlots());
  const history = createHistoryService({ registry, log });
  cleanup.push(async () => history.dispose());
  // fleet-drawer plan §5.2/§5.3 (F3b): the run-transcript service + its F3a file reader —
  // constructed unconditionally (per-request capability gating happens against the AGENT's
  // hello caps in the service's `requireCap`, §7.1; an agent without `runtx.*` caps is simply
  // refused there). The service owns no timers; `dispose()` drops its bus subscription and
  // every held watch. Both the runtime `close()` below and this startup-failure `cleanup`
  // entry dispose explicitly — the runtime path never runs the cleanup array (upload plan
  // #13's finding), so `close()` carries its own calls next to `history.dispose()`.
  const runFileReader = createRunFileReader({ now });
  const runTx = createRunTranscriptService({ registry, reader: runFileReader, log, now });
  cleanup.push(async () => {
    runTx.dispose();
    runFileReader.dispose();
  });

  return { registry, unsubscribeBotSlots, history, runFileReader, runTx };
}
