/** Own temporary C/D/review/E, actual revision host and actual command kernel.
 * Scripted remote is only the UI boundary, not a fake commit result. */
import type { MemoryOwner } from "../../../src/memory/scopes/types.js";
import type { OwnedRevisionAction } from "../../../src/memory/govern/revision-commit.js";
import { afterEach } from "vitest";
import { hostFixture } from "./revision-host-helpers.js";
import { createRevisionHost } from "../../../src/memory/govern/revision-host.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { createCommandConfirmKernel, type CommandClock } from "../../../src/memory/command-confirm.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../../src/ask-user/remote.js";
import { createRevisionWebCommand } from "../../../src/memory/govern/revision-web-command.js";
export class R4Clock implements CommandClock {
  time = 1000;
  timers = new Map<object, { at: number; fn: () => void }>();
  now() {
    return this.time;
  }
  setTimer(ms: number, fn: () => void) {
    const t = {};
    this.timers.set(t, { at: this.time + ms, fn });
    return t;
  }
  clearTimer(t: unknown) {
    this.timers.delete(t as object);
  }
  advance(ms: number) {
    this.time += ms;
    for (const [t, v] of this.timers) if (v.at <= this.time && this.timers.delete(t)) v.fn();
  }
}
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});
export async function r4Host(count = 2) {
  const h = await hostFixture(count);
  const custody = new AbortController(),
    manager = {},
    owner = { incarnation: {}, sid: "r4-session", sessionEpoch: 1, branchGen: 0 };
  let current = true;
  const host = createRevisionHost({
    client: h.client,
    binding: () => h.binding,
    isCurrent: () => h.state.current,
    canAttempt: () => h.state.admit,
    autoEnabled: () => false,
    now: () => new Date("2026-11-10T00:00:00Z"),
    onAfterWrite() {
      throw Error("auto disabled");
    },
    custody: () => ({ owner, manager, epoch: owner.sessionEpoch, signal: custody.signal, isCurrent: () => current }),
  });
  disposers.push(() => host.dispose());
  const result = await host.handle(h.batch(), h.attempt);
  const rows = () => readIndex(h.dir).index.review?.suggestions.filter((s) => s.revision) ?? [];
  return {
    ...h,
    host,
    custody,
    manager,
    owner,
    result,
    rows,
    revoke() {
      current = false;
      custody.abort();
    },
  };
}
export function r4Command(
  h: {
    readonly dir: string;
    readonly custody: AbortController;
    readonly owner: MemoryOwner;
    readonly manager: object;
    readonly policyVersion: string;
    readonly host: { actionLocked(memDir: string, actionId: string): OwnedRevisionAction | undefined };
  },
  options: {
    cmdId?: string;
    approve?: boolean;
    rawArgs?: string;
    autoAnswer?: boolean;
  } = {},
) {
  const clock = new R4Clock(),
    command = new AbortController();
  const questions: string[] = [],
    answers: ((v?: string, originKind?: "lan" | "feishu") => boolean)[] = [];
  const remote: AskUserRemotePort = {
    open(req) {
      questions.push(req.questions[0]!.question);
      const affirm = req.questions[0]!.options[1]!.label;
      return {
        setOnRemote(fn) {
          const answer = (
            v = options.approve === false ? req.questions[0]!.options[0]!.label : affirm,
            originKind: "lan" | "feishu" = "lan",
          ) => fn({ kind: "answer", origin: "local-test", originKind, answers: { MEMCMD: v } } satisfies RemoteOutcome);
          answers.push(answer);
          if (options.autoAnswer !== false) queueMicrotask(() => answer());
        },
        close() {},
      };
    },
  };
  const kernel = createCommandConfirmKernel({
    channel: { kind: "web", remote },
    clock,
    isOwnerCurrent: () => !h.custody.signal.aborted,
  });
  disposers.push(() => kernel.dispose());
  const rawArgs = options.rawArgs ?? "review";
  const call = kernel.start(rawArgs, {
    cmdId: options.cmdId ?? "r4-command",
    commandOwner: "r4-handler",
    operationGeneration: 1,
    owner: h.owner,
    manager: h.manager,
    deadline: clock.now() + 29 * 60000,
    signal: command.signal,
    current: () => !command.signal.aborted && !h.custody.signal.aborted,
  })!;
  const deps = {
    memDir: h.dir,
    contextDir: h.dir,
    rawArgs,
    call,
    kernel,
    host: h.host,
    runtime: () => ({
      plainMain: true,
      enabled: true,
      autoEnabled: false,
      sessionEpoch: h.owner.sessionEpoch,
      policyVersion: h.policyVersion,
      dateRuleVersion: "date-v1",
    }),
    isCurrent: () => !h.custody.signal.aborted,
    now: () => new Date("2026-11-10T00:00:00Z"),
  };
  const domain = createRevisionWebCommand(deps);
  return { clock, command, kernel, call, deps, domain, questions, answers };
}
export async function until(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++) await Promise.resolve();
  if (!test()) throw Error("expected microtask state did not arrive");
}

/** Real D deterministic proposals, C barriers and original review owner. History
 * has NO host custody. Used for 16-target/16-effect limits, not fake successes. */
export async function addR4History(h: Awaited<ReturnType<typeof r4Host>>, count: number) {
  const { parseBlockFile } = await import("../../../src/memory/blocks/format.js");
  const { freezeRevisionInputsLocked, planRevisionActions } = await import("../../../src/memory/govern/revision.js");
  const { createRevisionAuditPort } = await import("../../../src/memory/govern/revision-audit.js");
  const { upsertRevisionSuggestion } = await import("../../../src/memory/govern/review-lite.js");
  const { withMemoryDirLock } = await import("../../../src/memory/lock.js");
  const { inspectDirNoFollow, readRegularBytes } = await import("../../../src/memory/safe-fs.js");
  const { join } = await import("node:path");
  const { dev, ino } = inspectDirNoFollow(h.dir);
  for (let i = 0; i < count; i++) {
    const id = `extra.${String(i + 1).padStart(3, "0")}`;
    h.write(id, `Preserve additional rule ${i}.`);
    const target = parseBlockFile(`${id}.md`, readRegularBytes(h.blocks, `${id}.md`).bytes.toString("utf8"));
    if ("stray" in target) throw Error("bad test block");
    const f = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: { realpath: h.dir, dev, ino, sessionEpoch: 1 },
          selectionBatchId: `history-${i}`,
          policyVersion: h.policyVersion,
          action: "expires",
          target,
        },
        { isCurrent: () => !h.custody.signal.aborted },
      ),
    );
    if ("kind" in f) throw Error("test D freeze rejected");
    const proposal = planRevisionActions({
      candidates: [
        { frozen: f, reason: "expired", expiry: { op: "set", nextExpires: "2027-01-01", dateRuleVersion: "date-v1" } },
      ],
      autoEnabled: false,
      leaseValid: false,
    })[0]!;
    const deps = { isCurrent: () => !h.custody.signal.aborted, now: () => new Date("2026-11-10T00:00:00Z") };
    const result = await upsertRevisionSuggestion(
      h.dir,
      { frozen: f, proposal, origin: "p50-suggestion" },
      { ...deps, leaseValid: () => false, audit: createRevisionAuditPort(h.dir, deps) },
    );
    if (result !== "saved") throw Error(`test C/review save ${result}`);
  }
}
