/** Child-process probe: the default strict Node unhandled-rejection policy must stay active. */
import assert from "node:assert/strict";
import { createCommandConfirmKernel } from "../../../src/memory/command-confirm.js";
import type { AskUserRemotePort, RemoteOutcome } from "../../../src/ask-user/remote.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import type { MemoryOwner } from "../../../src/memory/scopes/types.js";

const mode = process.argv[2];
assert(["resolved", "rejected-immediate", "rejected-later"].includes(mode ?? ""));
const owner: MemoryOwner = { incarnation: {}, sid: "thenable-probe", sessionEpoch: 1, branchGen: 1 };
const manager = {};
let remoteAnswer: ((outcome: RemoteOutcome) => boolean) | undefined;
let affirm = "";
const remote: AskUserRemotePort = {
  open(request) {
    affirm = request.questions[0]!.options[1]!.label;
    return {
      setOnRemote(callback) {
        remoteAnswer = callback;
      },
      close() {},
    };
  },
};
const kernel = createCommandConfirmKernel({ channel: { kind: "web", remote }, isOwnerCurrent: () => true });
let consumes = 0;
const consume = kernel.consume.bind(kernel);
kernel.consume = (...args) => {
  consumes++;
  return consume(...args);
};
let appends = 0;
let rejectLater: ((error: Error) => void) | undefined;
let lateRejectionStarted = false;
const store = createSessionMemoryStore({
  currentOwner: () => owner,
  isLocked: () => false,
  getBranch: () => [],
  getSessionId: () => owner.sid,
  getSessionFile: () => undefined,
  getManager: () => manager,
  appendCustomEntry: () => {
    appends++;
    if (mode === "resolved") return Promise.resolve();
    if (mode === "rejected-immediate") return Promise.reject(new Error("APPEND_REJECT_PROBE"));
    return new Promise<void>((_resolve, reject) => {
      rejectLater = reject;
    });
  },
  now: () => "2026-11-07T00:00:00.000Z",
  webConfirm: () => kernel,
  poisonRegistry: createSessionPoisonRegistry(),
  stableSessionIdentity: () => "thenable-probe",
});
const call = kernel.start("session add probe", {
  cmdId: "probe",
  commandOwner: "activation",
  operationGeneration: 1,
  owner,
  manager,
  deadline: Date.now() + 60_000,
  signal: new AbortController().signal,
  current: () => true,
});
assert(call);
const prepared = await store.prepareWebAdd(call, { kind: "session.add", rawArgs: "session add probe", text: "probe" });
assert(prepared.ok);
const confirmation = kernel.confirm(call, prepared.plan.commandPlan);
assert.equal(
  remoteAnswer?.({ kind: "answer", answers: { MEMCMD: affirm }, origin: "test", originKind: "loopback" }),
  true,
);
const approval = await confirmation;
assert(approval.approved);
assert(kernel.reserve(call, approval.receipt, prepared.plan.commandPlan));
const outcome = await store.enqueueConfirmedCommand(call, prepared.plan, approval.receipt);
assert.deepEqual(
  { ok: outcome.ok, effect: outcome.effect, code: outcome.ok ? undefined : outcome.code },
  { ok: false, effect: "unknown", code: "E_PERSIST_UNKNOWN" },
);
assert.equal(appends, 1);
assert.equal(consumes, 1);
assert.equal(store.poisonedNow(), true);
if (mode === "rejected-later") {
  assert(rejectLater);
  // Explicitly reject only after the consumer has already returned unknown.
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      lateRejectionStarted = true;
      rejectLater!(new Error("APPEND_LATE_REJECT_PROBE"));
      resolve();
    }),
  );
  assert(lateRejectionStarted);
}
// Allow the host's unhandled-rejection check to run; no process handler suppresses it.
await new Promise<void>((resolve) => setImmediate(resolve));
store.releaseWeb(call);
kernel.dispose();
console.log(JSON.stringify({ mode, outcome, appends, consumes, poisoned: store.poisonedNow(), lateRejectionStarted }));
