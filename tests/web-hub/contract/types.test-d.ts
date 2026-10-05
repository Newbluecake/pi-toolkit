/**
 * Compile-time contract test (plan §11 "typecheck" row): pins the frozen
 * type-level guarantees that a plain `vitest run` (which only type-strips via
 * esbuild) cannot catch on its own. Enforced by `npm run typecheck`, which
 * runs `tsc --noEmit -p tsconfig.json` (src/**) *and*
 * `tsc --noEmit -p tsconfig.typecheck.json` (src/** + this file) — review
 * fix #1: this file used to be orphaned (neither `tsconfig.json`'s `include`
 * nor any vitest `test.typecheck` block covered it), so a broken assertion
 * here could pass CI silently. At the `vitest run` level this file also
 * still executes its `it()` bodies (all no-ops at runtime —
 * `expectTypeOf(...).toEqualTypeOf<...>()` never throws) so a
 * collection/syntax regression is caught there too.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expectTypeOf, it } from "vitest";
import type { RunningHub } from "../../../src/web-hub/hub/hub.js";
import type {
  ConnGuard,
  ConnLease,
  CommandRouter,
  FrontendDeps,
  HubConfig,
  HubEvent,
  KdfAdmissionPort,
  LanStorePort,
  LanUserSummary,
  PortOptions,
} from "../../../src/web-hub/hub/ports.js";
import type { CommandRouter as CommandsCommandRouter } from "../../../src/web-hub/hub/commands.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import type {
  FirstPromptRouterPort,
  SpawnFrontendPort,
  SpawnRegistryPort,
  SpawnRouteIo,
} from "../../../src/web-hub/hub/spawn/ports.js";
import type { SseEventName } from "../../../src/web-hub/hub/sse.js";
import type { FenceLoss, SingletonResult } from "../../../src/web-hub/hub/singleton.js";
import type { HostTokenResult } from "../../../src/web-hub/protocol/lan.js";
import type {
  AgentFrame,
  CmdArgs,
  CmdData,
  CmdErrorCode,
  CmdFrame,
  CommandOutputWire,
  FleetOmitted,
  HubCtlFrame,
  HubFrame,
  WireEntry,
  WireEvent,
} from "../../../src/web-hub/protocol/messages.js";
import type {
  RunEndFrame,
  RunEvFrame,
  RunGapFrame,
  RunHistoryError,
  RunHistoryPayload,
  RunTxReason,
  RunTxReplyFrame,
  RunTxReqFrame,
  RunWatchFrame,
} from "../../../src/web-hub/protocol/run-transcript.js";
import type {
  DirEntryWire,
  FirstPromptState,
  HubSpawnConfig,
  SpawnEndReason,
  SpawnHint,
  SpawnRecordOwner,
  SpawnRecordPublic,
  SpawnState,
  SpawnsPayload,
} from "../../../src/web-hub/protocol/spawn.js";

describe("types.test-d.ts (plan §11 typecheck contract)", () => {
  it("P1-shaped FrontendDeps (no `lan`) is still assignable to FrontendDeps", () => {
    type P1FrontendDeps = Omit<FrontendDeps, "lan">;
    expectTypeOf<P1FrontendDeps>().toMatchTypeOf<FrontendDeps>();
  });

  it("P1-shaped HubConfig (no `lan`) is still assignable to HubConfig", () => {
    type P1HubConfig = Omit<HubConfig, "lan">;
    expectTypeOf<P1HubConfig>().toMatchTypeOf<HubConfig>();
  });

  it("RunningHub's LAN additions (`lan`, `lanStatus`) are optional / function-typed", () => {
    expectTypeOf<RunningHub["lanStatus"]>().toBeFunction();
    expectTypeOf<undefined>().toMatchTypeOf<RunningHub["lan"]>();
  });

  it("RunningHub.identity is present (required — set at bind time, §1.3.2)", () => {
    expectTypeOf<RunningHub>().toHaveProperty("identity");
    expectTypeOf<RunningHub["identity"]>().not.toBeUndefined();
  });

  it('SseEventName includes "auth"', () => {
    expectTypeOf<"auth">().toMatchTypeOf<SseEventName>();
  });

  it("HostTokenResult's ok:false branch `reason` is exactly the 5 documented literals", () => {
    type Reason = Extract<HostTokenResult, { ok: false }>["reason"];
    expectTypeOf<Reason>().toEqualTypeOf<"syntax" | "denylisted" | "ipv6" | "too-long" | "numeric">();
  });

  it("FenceLoss is exactly the 7 documented literals", () => {
    expectTypeOf<FenceLoss>().toEqualTypeOf<
      | "socket-missing"
      | "socket-replaced"
      | "socket-symlink"
      | "socket-not-socket"
      | "dir-replaced"
      | "owner-mismatch"
      | "io"
    >();
  });

  it('SingletonResult\'s failed.reason includes "aborted"', () => {
    type FailedReason = NonNullable<Extract<SingletonResult, { kind: "failed" }>["reason"]>;
    expectTypeOf<"aborted">().toMatchTypeOf<FailedReason>();
  });

  // Review fix #9 (v1): ConnGuard is a frozen interface (not `unknown`), and admits by lease —
  // never by re-keying on `peerIp` (that would double-release / mis-attribute categories
  // when the same peerIp holds multiple connections). Review fix #4 (v2): admit() also takes an
  // `onEvict` callback so §6.3's "evict an older connection and destroy it" is expressible.
  it("ConnGuard.admit returns a ConnLease | undefined, keyed by lease identity (not peerIp), and takes onEvict", () => {
    expectTypeOf<ConnGuard["admit"]>()
      .parameter(0)
      .toEqualTypeOf<{ peerIp: string; viaTrustedProxy: boolean; onEvict: () => void }>();
    expectTypeOf<ReturnType<ConnGuard["admit"]>>().toEqualTypeOf<ConnLease | undefined>();
    expectTypeOf<ConnLease>().toHaveProperty("release");
    expectTypeOf<ConnLease["release"]>().parameters.toEqualTypeOf<[]>(); // no peerIp/category argument
    expectTypeOf<ConnLease>().toHaveProperty("enterLoginPending");
    expectTypeOf<ConnLease>().toHaveProperty("enterAuthed");
    // LC review fix (lan-plan.md §15.8): the missing inverse of enterLoginPending() — every
    // login-pending request must end by promoting to authed *or* falling back to evictable unauth.
    expectTypeOf<ConnLease>().toHaveProperty("leaveLoginPending");
    expectTypeOf<ConnLease["leaveLoginPending"]>().parameters.toEqualTypeOf<[]>();
  });

  // Review fix #9: request-level ports that may queue/run long enough to matter accept an
  // optional AbortSignal (deadline *values* stay each port's own implementation detail).
  it("KdfAdmissionPort.acquire and LanStorePort's request-level ops accept opts?: PortOptions", () => {
    expectTypeOf<Parameters<KdfAdmissionPort["acquire"]>[2]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<Parameters<LanStorePort["touchSession"]>[2]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<Parameters<LanStorePort["getUser"]>[1]>().toEqualTypeOf<PortOptions | undefined>();
    expectTypeOf<PortOptions>().toHaveProperty("signal");
    expectTypeOf<PortOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
  });

  // Review fix #5 (v2): createSession returns the *raw* sid (for the cookie), never a hash;
  // getUserSummary looks a user up by userId (touchSession's LanSessionRecord.userId) for
  // GET /api/session's {username, initialPasswordInUse} (§7, §5.2).
  it("LanStorePort.createSession returns {sid}; getUserSummary(userId) returns a LanUserSummary", () => {
    expectTypeOf<Awaited<ReturnType<LanStorePort["createSession"]>>>().toEqualTypeOf<{ sid: string }>();
    expectTypeOf<Parameters<LanStorePort["getUserSummary"]>[0]>().toEqualTypeOf<number>();
    expectTypeOf<Awaited<ReturnType<LanStorePort["getUserSummary"]>>>().toEqualTypeOf<LanUserSummary | undefined>();
    expectTypeOf<LanUserSummary>().toEqualTypeOf<{ username: string; initialPasswordInUse: boolean }>();
  });
});

// P2 control-plane frozen surface (plan §3.1/§3.2, package C0).
describe("types.test-d.ts (P2 control-plane, plan §3.1/§3.2)", () => {
  it("CmdArgs is a discriminated union keyed by op, one variant per CmdOp", () => {
    expectTypeOf<CmdArgs["op"]>().toEqualTypeOf<
      "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "dialog_answer" | "dialog_cancel" | "command"
    >();
  });

  it("CmdFrame.cmd is exactly CmdArgs; CmdFrame.id/deadlineMs/origin are required", () => {
    expectTypeOf<CmdFrame["cmd"]>().toEqualTypeOf<CmdArgs>();
    expectTypeOf<CmdFrame>().toHaveProperty("deadlineMs");
    expectTypeOf<CmdFrame["deadlineMs"]>().toEqualTypeOf<number>();
    expectTypeOf<CmdFrame["queryOnly"]>().toEqualTypeOf<true | undefined>();
  });

  it("CmdErrorCode is exactly the 18 documented literals (incl. v2.1 E_HUB_RESTARTING, todo #32 E_RATE)", () => {
    expectTypeOf<CmdErrorCode>().toEqualTypeOf<
      | "E_UNSUPPORTED"
      | "E_STALE_CTX"
      | "E_BUSY_COMPACTING"
      | "E_BUSY_STEER"
      | "E_SESSION_CHANGED"
      | "E_BAD_REQUEST"
      | "E_NOT_FOUND"
      | "E_UNKNOWN_ID"
      | "E_NOT_RUNNING"
      | "E_SUBAGENT_REJECTED"
      | "E_DIALOG_CLOSED"
      | "E_BAD_ANSWER"
      | "E_UNKNOWN_COMMAND"
      | "E_COMMAND_DENIED"
      | "E_CONFIRM_REQUIRED"
      | "E_DEADLINE"
      | "E_HUB_RESTARTING"
      | "E_RATE"
    >();
  });

  it("CmdData's command variant carries kind/completion/captured?/output? (v2.1)", () => {
    type CommandData = Extract<CmdData, { op: "command" }>;
    expectTypeOf<CommandData["kind"]>().toEqualTypeOf<"extension" | "template" | "builtin">();
    expectTypeOf<CommandData["completion"]>().toEqualTypeOf<"sync" | "async" | "unknown" | "timeout">();
    expectTypeOf<CommandData["captured"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<CommandData["output"]>().toEqualTypeOf<CommandOutputWire | undefined>();
  });

  it("CommandOutputWire.entries[].kind covers all 6 documented kinds", () => {
    expectTypeOf<CommandOutputWire["entries"][number]["kind"]>().toEqualTypeOf<
      "notify" | "widget" | "status" | "text" | "error" | "interactive"
    >();
    expectTypeOf<CommandOutputWire["needsTerminal"]>().toEqualTypeOf<true | undefined>();
  });

  it("HubCtlFrame is a union of shutdown{reason} and rotate_token (v2.1; no shared reason field)", () => {
    expectTypeOf<HubCtlFrame["op"]>().toEqualTypeOf<"shutdown" | "rotate_token">();
    type Shutdown = Extract<HubCtlFrame, { op: "shutdown" }>;
    expectTypeOf<Shutdown["reason"]>().toEqualTypeOf<"restart" | "stop">();
    type Rotate = Extract<HubCtlFrame, { op: "rotate_token" }>;
    expectTypeOf<Rotate>().not.toHaveProperty("reason");
  });

  it("HubEvent includes dialogs/ctl/commands/cmd_late (todo #32 P0 fix, plan §3.2/§6.1/§6.6)", () => {
    expectTypeOf<HubEvent["type"]>().toEqualTypeOf<
      | "agent_up"
      | "agent_down"
      | "agent_stale"
      | "session"
      | "ev"
      | "status"
      | "fleet"
      | "prompt"
      | "gap"
      | "append"
      | "dialogs"
      | "ctl"
      | "commands"
      | "cmd_late"
      | "hub"
      | "spawns"
    >();
    // §6.6's documented SSE payload shapes, pinned on the bus event itself.
    type Dialogs = Extract<HubEvent, { type: "dialogs" }>;
    expectTypeOf<Dialogs>().toHaveProperty("agentKey");
    expectTypeOf<Dialogs>().toHaveProperty("epoch");
    expectTypeOf<Dialogs>().toHaveProperty("open");
    expectTypeOf<Dialogs>().toHaveProperty("closed");
    type Ctl = Extract<HubEvent, { type: "ctl" }>;
    expectTypeOf<Ctl>().toHaveProperty("sessionId");
    expectTypeOf<Ctl>().toHaveProperty("items");
    type Commands = Extract<HubEvent, { type: "commands" }>;
    expectTypeOf<Commands>().toHaveProperty("items");
    type CmdLate = Extract<HubEvent, { type: "cmd_late" }>;
    expectTypeOf<CmdLate["op"]>().not.toBeUnknown();
    expectTypeOf<CmdLate["ok"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CmdLate["code"]>().toEqualTypeOf<CmdErrorCode | undefined>();
  });

  it("FrontendDeps.commands is an optional CommandRouter (todo #32 P0 fix, plan §6.1)", () => {
    expectTypeOf<FrontendDeps>().toHaveProperty("commands");
    expectTypeOf<undefined>().toMatchTypeOf<FrontendDeps["commands"]>();
    expectTypeOf<CommandRouter>().toMatchTypeOf<NonNullable<FrontendDeps["commands"]>>();
  });

  it("hub/commands.ts's CommandRouter is the SAME type as ports.ts's, not a competing duplicate (unified §6.1 signature)", () => {
    expectTypeOf<CommandsCommandRouter>().toEqualTypeOf<CommandRouter>();
    // both call it `request`, not `run` — a signature mismatch here would fail to compile.
    expectTypeOf<CommandRouter["request"]>().not.toBeUnknown();
  });
});

// web-hub-spawn plan §SP1 (v2.1, review #3 硬门槛): type-only ports + the frozen spawn wire
// surface. These pins live here (not in tests/web-hub/protocol/*) because ONLY this file is
// covered by `npm run typecheck`'s second tsc pass — plain vitest never evaluates type-level
// expectTypeOf assertions.
describe("types.test-d.ts (web-hub-spawn SP1 ports & wire surface)", () => {
  it("Registry satisfies SpawnRegistryPort; CommandRouter satisfies FirstPromptRouterPort (#3)", () => {
    expectTypeOf<Registry>().toMatchTypeOf<SpawnRegistryPort>();
    expectTypeOf<CommandRouter>().toMatchTypeOf<FirstPromptRouterPort>();
    // the ports are exactly the Picked members — nothing wider snuck in
    expectTypeOf<keyof SpawnRegistryPort>().toEqualTypeOf<"list" | "get" | "bus" | "publish" | "getCaps">();
    expectTypeOf<keyof FirstPromptRouterPort>().toEqualTypeOf<"request">();
  });

  it("HubEvent's spawns member carries the Public projection payload (SpawnsPayload)", () => {
    type Spawns = Extract<HubEvent, { type: "spawns" }>;
    expectTypeOf<Spawns["payload"]>().toEqualTypeOf<SpawnsPayload>();
  });

  it("FrontendDeps.spawn and HubConfig.spawn are optional and additive (SP9/SP2 fill them in)", () => {
    expectTypeOf<undefined>().toMatchTypeOf<FrontendDeps["spawn"]>();
    expectTypeOf<SpawnFrontendPort>().toMatchTypeOf<NonNullable<FrontendDeps["spawn"]>>();
    expectTypeOf<undefined>().toMatchTypeOf<HubConfig["spawn"]>();
    expectTypeOf<HubSpawnConfig>().toMatchTypeOf<NonNullable<HubConfig["spawn"]>>();
    // P1/P2-era deps/config shapes (no spawn key) stay assignable — additions are optional only.
    type PreSpawnDeps = Omit<FrontendDeps, "spawn">;
    type PreSpawnConfig = Omit<HubConfig, "spawn">;
    expectTypeOf<PreSpawnDeps>().toMatchTypeOf<FrontendDeps>();
    expectTypeOf<PreSpawnConfig>().toMatchTypeOf<HubConfig>();
  });

  it("SpawnFrontendPort.handle/publicPayload keep their frozen signatures", () => {
    expectTypeOf<Parameters<SpawnFrontendPort["handle"]>>().toEqualTypeOf<
      [IncomingMessage, ServerResponse, string, string, URLSearchParams, SpawnRouteIo]
    >();
    expectTypeOf<Awaited<ReturnType<SpawnFrontendPort["handle"]>>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<SpawnFrontendPort["publicPayload"]>>().toEqualTypeOf<SpawnsPayload | undefined>();
  });

  it("spawn wire enums are exactly the frozen literal unions (arch §8.1)", () => {
    expectTypeOf<SpawnState>().toEqualTypeOf<"starting" | "live" | "stopping" | "exited" | "failed">();
    expectTypeOf<SpawnEndReason>().toEqualTypeOf<
      | "user"
      | "lifetime"
      | "hub"
      | "crash"
      | "orphan"
      | "protocol_error"
      | "spawn_error"
      | "register_timeout"
      | "exited_early"
      | "cwd_mismatch"
    >();
    expectTypeOf<SpawnHint>().toEqualTypeOf<
      | "register-timeout-hello"
      | "register-timeout-session"
      | "control-off"
      | "newer-plugin"
      | "cwd-mismatch"
      | "protocol-error"
      | "launcher-changed"
    >();
    expectTypeOf<FirstPromptState>().toEqualTypeOf<"pending" | "sending" | "delivered" | "failed" | "expired">();
    expectTypeOf<DirEntryWire>().toEqualTypeOf<{ cwd: string; label: string; at: number }>();
  });

  it("SpawnRecordOwner widens SpawnRecordPublic owner-only (arch §6.4: never on SSE)", () => {
    expectTypeOf<NonNullable<SpawnRecordPublic["firstPrompt"]>>().toEqualTypeOf<{
      state: FirstPromptState;
      code?: string;
    }>();
    expectTypeOf<SpawnRecordOwner>().toHaveProperty("cwd");
    expectTypeOf<SpawnRecordOwner>().toHaveProperty("hintDetail");
    expectTypeOf<SpawnRecordOwner>().toHaveProperty("stderrTail");
    expectTypeOf<SpawnRecordOwner>().toHaveProperty("uiCancelled");
    // the owner's firstPrompt adds textLen/attempts — the body itself is NEVER on any type.
    expectTypeOf<NonNullable<SpawnRecordOwner["firstPrompt"]>>().toEqualTypeOf<{
      state: FirstPromptState;
      code?: string;
      textLen: number;
      attempts: number;
    }>();
  });
});

// web-hub-fleet-drawer plan §3.1/§3.2 (F0): the run-transcript wire surface. These pins live
// here (not in tests/web-hub/protocol/*) for the same reason as the spawn block above — only
// this file is covered by `npm run typecheck`'s second tsc pass.
describe("types.test-d.ts (fleet-drawer F0 run-transcript wire surface)", () => {
  it("RunTxReason is exactly the 10 frozen §3.6 literals", () => {
    expectTypeOf<RunTxReason>().toEqualTypeOf<
      | "unknown_run"
      | "not_persisted"
      | "file_missing"
      | "leaf_unknown"
      | "leaf_missing"
      | "too_large"
      | "parse_error"
      | "unsupported"
      | "busy"
      | "resync_storm"
    >();
  });

  it("RunTxReplyFrame is three mutually exclusive branches (ok×source keyed, LanRes-style)", () => {
    type Live = Extract<RunTxReplyFrame, { ok: true; source: "live" }>;
    expectTypeOf<Live["entries"]>().toEqualTypeOf<WireEntry[]>();
    expectTypeOf<Live["tapId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Live["seq"]>().toEqualTypeOf<number>();
    expectTypeOf<Live["watching"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Live>().not.toHaveProperty("sessionFile");
    expectTypeOf<Live>().not.toHaveProperty("finalLeafId");
    type File = Extract<RunTxReplyFrame, { ok: true; source: "file" }>;
    expectTypeOf<File["sessionFile"]>().toEqualTypeOf<string>();
    expectTypeOf<File["finalLeafId"]>().toEqualTypeOf<string>();
    expectTypeOf<File>().not.toHaveProperty("entries");
    type Err = Extract<RunTxReplyFrame, { ok: false }>;
    expectTypeOf<Err["code"]>().toEqualTypeOf<"E_NOT_FOUND" | "E_UNSUPPORTED">();
    expectTypeOf<Err["reason"]>().toEqualTypeOf<RunTxReason>();
    expectTypeOf<Err>().not.toHaveProperty("entries");
  });

  it("RunTxReqFrame / RunWatchFrame / RunEvFrame / RunGapFrame / RunEndFrame keep their §3.1 shapes", () => {
    expectTypeOf<RunTxReqFrame["t"]>().toEqualTypeOf<"run_tx_req">();
    expectTypeOf<RunTxReqFrame["before"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RunTxReqFrame["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<RunTxReqFrame["maxBytes"]>().toEqualTypeOf<number>();
    expectTypeOf<RunWatchFrame["t"]>().toEqualTypeOf<"run_watch">();
    expectTypeOf<RunWatchFrame["on"]>().toEqualTypeOf<boolean>();
    expectTypeOf<RunEvFrame["e"]>().toEqualTypeOf<WireEvent>();
    expectTypeOf<RunEvFrame["tapId"]>().toEqualTypeOf<string>();
    expectTypeOf<RunGapFrame["fromSeq"]>().toEqualTypeOf<number>();
    expectTypeOf<RunEndFrame["lastSeq"]>().toEqualTypeOf<number>();
    expectTypeOf<RunEndFrame["status"]>().toEqualTypeOf<string>();
  });

  it("RunHistoryPayload never carries sessionFile/finalLeafId (§5.2 strips them before the browser)", () => {
    expectTypeOf<RunHistoryPayload>().not.toHaveProperty("sessionFile");
    expectTypeOf<RunHistoryPayload>().not.toHaveProperty("finalLeafId");
    expectTypeOf<RunHistoryPayload["source"]>().toEqualTypeOf<"live" | "file">();
    expectTypeOf<NonNullable<RunHistoryPayload["resync"]>>().toEqualTypeOf<true>();
    expectTypeOf<RunHistoryError["error"]>().toEqualTypeOf<
      "E_NOT_FOUND" | "E_UNSUPPORTED" | "E_BUSY" | "E_DEADLINE" | "E_AGENT_GONE"
    >();
  });

  it("AgentFrame carries the four agent→hub run frames; HubFrame the two hub→agent ones", () => {
    expectTypeOf<Extract<AgentFrame, { t: "run_tx_reply" }>>().toEqualTypeOf<RunTxReplyFrame>();
    expectTypeOf<Extract<AgentFrame, { t: "run_ev" }>>().toEqualTypeOf<RunEvFrame>();
    expectTypeOf<Extract<AgentFrame, { t: "run_gap" }>>().toEqualTypeOf<RunGapFrame>();
    expectTypeOf<Extract<AgentFrame, { t: "run_end" }>>().toEqualTypeOf<RunEndFrame>();
    expectTypeOf<Extract<HubFrame, { t: "run_tx_req" }>>().toEqualTypeOf<RunTxReqFrame>();
    expectTypeOf<Extract<HubFrame, { t: "run_watch" }>>().toEqualTypeOf<RunWatchFrame>();
  });

  it("the fleet frame's omitted is an optional FleetOmitted (§3.2 #12)", () => {
    type Fleet = Extract<AgentFrame, { t: "fleet" }>;
    expectTypeOf<Fleet["omitted"]>().toEqualTypeOf<FleetOmitted | undefined>();
    expectTypeOf<FleetOmitted>().toEqualTypeOf<{ active: number; terminal: number }>();
  });
});
