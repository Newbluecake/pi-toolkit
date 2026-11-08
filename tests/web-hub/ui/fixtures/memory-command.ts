import { computed } from "vue";
import { useHub } from "../../../../src/web-hub/ui/src/composables/useHub.js";
import type { MemoryUiKey } from "../../../../src/web-hub/ui/src/types.js";
import type { ControlView } from "../../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { CmdOutcome, CmdRequest, HubTransport } from "../../../../src/web-hub/ui/src/transport/types.js";

/**
 * #65 package 3 component seam. NO fake reducer or pre-baked cmdResult.
 * I supplies command() backed by the real commands handler/ledger, and forwards real ctl /
 * cmd_late frames to emit(). This fixture itself does NOT prove S1 cancel/consume/append.
 * It is browser-compatible (no test-utils, node imports, SDK or production memory data).
 */
export function createMemoryCommandFixture(opts: {
  command(req: CmdRequest): Promise<CmdOutcome>;
  history?: boolean;
  /** I supplies the actual isolated host's UI owner; never use production user memory. */
  owner?: MemoryUiKey["owner"];
  now?: () => number;
}) {
  const calls: CmdRequest[] = [];
  const transport: HubTransport = {
    mode: "token",
    start: async () => {},
    close: () => {},
    subscribe: async () => ({ ok: true }),
    unsubscribe: async () => {},
    page: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
    command: (req) => {
      calls.push(req);
      return opts.command(req);
    },
    dialog: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false, effect: "none" }),
  };
  const hub = useHub({
    createTransport: () => transport,
    doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    win: { addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const card = {
    agentKey: opts.owner?.agentKey ?? "memory-fixture",
    epoch: opts.owner?.epoch ?? "fixture-epoch",
    kind: "tui",
    pid: 1,
    cwd: "/tmp/memory-ui-fixture",
    state: "live",
    control: true,
    session: {
      sessionId: opts.owner?.sessionId ?? "fixture-session",
      cwd: "/tmp/memory-ui-fixture",
      leafId: null,
      mode: "tui",
      reason: "startup",
    },
    status: { busy: false, pending: false, features: opts.history ? ["cmd.history.v1"] : [] },
    prompts: [],
    commands: [{ name: "mem", kind: "extension", policy: "allow", output: "captured" }],
  };
  const emit = (event: string, data: unknown) => hub.dispatch({ event, data });
  emit("conn", { state: "open" });
  emit("hello", { clientId: "fixture-client" });
  emit("hub", { caps: ["cmd.v1", ...(opts.history ? ["cmd.history.v1"] : [])], state: "running" });
  emit("agents", [card]);
  const agent = computed(() => hub.state.value.agents.get(card.agentKey)!);
  const view: ControlView = {
    agentKey: card.agentKey,
    control: hub.control ?? null,
    enabled: computed(
      () =>
        !agent.value.down &&
        hub.state.value.control === true &&
        agent.value.card["control"] === true &&
        agent.value.card["state"] !== "stale",
    ),
    readonlyReason: computed(() => null),
    agent,
    busy: computed(() => agent.value.status?.["busy"] === true),
    commands: computed(() => (agent.value.commands as readonly Record<string, unknown>[]) ?? []),
    commandsEnabled: computed(() => !agent.value.down && Array.isArray(agent.value.commands)),
    sending: computed(() =>
      (agent.value.pendingCtl ?? []).some((raw) => (raw as { state?: string }).state === "sending"),
    ),
    queueItems: computed(() => agent.value.pendingCtl ?? []),
    isWebMessage: () => false,
  };
  return { hub, view, card, calls, emit, dispose: () => hub.dispose() };
}
