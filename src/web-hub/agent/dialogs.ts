import type {
  CmdFrame,
  CmdOrigin,
  CmdResultBody,
  DialogAnswerWire,
  DialogClosedWire,
  DialogsFrame,
  DialogWire,
  WireEvent,
} from "../protocol/messages.js";
import { DIALOG_BG_HUB_CAPS } from "../protocol/version.js";
import { ASK_USER_MARKER } from "../../ask-user/channel-handler.js";
import { encodeAnswer } from "../../ask-user/answer-codec.js";
import type { AskUserAnswers, AskUserQuestion } from "../../ask-user/channel-handler.js";
import type { AskUserRemotePort, AskUserRemoteSession, RemoteOutcome } from "../../ask-user/remote.js";

const CLOSED_LIMIT = 8;
const CLOSED_TTL_MS = 120_000;
const OTHER_MAX_BYTES = 4 * 1024;

type DialogState = "open" | "closed";

type DialogRecord = {
  id: string;
  request: { toolCallId: string; questions: AskUserQuestion[]; allowCancel: boolean };
  wire: DialogWire;
  state: DialogState;
  attributed: boolean;
  onRemote?: (outcome: RemoteOutcome) => boolean;
};

export interface DialogBridgeOptions {
  setSlot?: (kind: "dialogs", frame: DialogsFrame) => void;
  isAttached?: () => boolean;
  notify?: (message: string) => void;
  now?: () => number;
  enabled?: boolean;
  epoch?: string;
  send?: (frame: { t: "cmd_result"; rid: string; id: string } & CmdResultBody) => void;
  /**
   * ask-user-async plan §7.2 (P3): live caps of the connected hub (`hello_ack.caps`, e.g.
   * `() => conn?.caps ?? []`). While the hub does not advertise `dialog.bg.v1`, `frame()` degrades
   * `closed[].by === "background"` to `"abort"` on the wire: an un-upgraded hub's runtime
   * `DialogClosedSchema` rejects unknown `by` values by dropping the WHOLE dialogs frame, which
   * would freeze the web dialog list for the closed records' TTL (`CLOSED_TTL_MS`). The internal
   * record keeps `"background"`, so once the hub is upgraded and the cap is advertised, the
   * same record re-emits as `"background"`. An absent (or throwing) getter is treated as
   * "hub lacks the cap" — the fail-safe direction keeps dialogs frames flowing.
   */
  hubCaps?: () => readonly string[];
}

export interface DialogBridge extends AskUserRemotePort {
  frame(): DialogsFrame;
  /** Handle a dialog cmd and optionally emit its cmd_result through `send`. */
  handle(frame: CmdFrame): CmdResultBody | undefined;
  answer(
    dialogId: string,
    answers: DialogAnswerWire[],
    origin?: string | CmdOrigin,
    cmdId?: string,
    epoch?: string,
  ): CmdResultBody;
  cancel(dialogId: string, origin?: string | CmdOrigin, cmdId?: string, epoch?: string): CmdResultBody;
  detachAll(): void;
  attributePrompt(event: WireEvent): WireEvent;
  dispose(): void;
}

function failure(code: "E_DIALOG_CLOSED" | "E_BAD_ANSWER", message: string, retryable = false): CmdResultBody {
  return { ok: false, code, message, retryable, effect: "none" };
}

function success(op: "dialog_answer" | "dialog_cancel"): CmdResultBody {
  return { ok: true, data: { op } };
}

function originText(origin: unknown): string {
  if (typeof origin === "string") return origin;
  if (origin !== null && typeof origin === "object") {
    const o = origin as { user?: unknown; ip?: unknown };
    const who = typeof o.user === "string" && o.user !== "" ? o.user : "local";
    const ip = typeof o.ip === "string" && o.ip !== "" ? o.ip : "127.0.0.1";
    return `${who}@${ip}`;
  }
  return "remote";
}

function validAnswers(record: DialogRecord, answers: DialogAnswerWire[]): string | undefined {
  if (!Array.isArray(answers) || answers.length !== record.request.questions.length) {
    return "answer count does not match questions";
  }
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i];
    const question = record.request.questions[i];
    if (answer === undefined || question === undefined) return "invalid answer";
    if (!Array.isArray(answer.selected) || answer.selected.some((label) => typeof label !== "string")) {
      return "selected must be an array of labels";
    }
    const labels = new Set(question.options.map((option) => option.label));
    const seen = new Set<string>();
    for (const label of answer.selected) {
      if (!labels.has(label)) return `unknown option: ${label}`;
      if (seen.has(label)) return `duplicate option: ${label}`;
      seen.add(label);
    }
    if (question.multiSelect !== true && answer.selected.length > 1)
      return "single-select question has multiple options";
    if (answer.other !== null && typeof answer.other !== "string") return "other must be a string or null";
    if (answer.other !== null && Buffer.byteLength(answer.other, "utf8") > OTHER_MAX_BYTES) return "other is too long";
    if (answer.other !== null && question.allowOther === false) return "other is not allowed";
    if (answer.selected.length === 0 && (answer.other === null || answer.other === "")) {
      return "each question needs an option or other answer";
    }
  }
  return undefined;
}

function encodeAnswers(questions: AskUserQuestion[], answers: DialogAnswerWire[]): AskUserAnswers {
  const result: AskUserAnswers = {};
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const answer = answers[i];
    if (question === undefined || answer === undefined) continue;
    const key = question.header ?? question.question;
    Object.assign(
      result,
      encodeAnswer(
        { selected: answer.selected, other: answer.other },
        {
          key,
          multiSelect: question.multiSelect === true,
        },
      ),
    );
  }
  return result;
}

export function createDialogBridge(options?: DialogBridgeOptions): DialogBridge {
  const configured = options !== undefined;
  const enabled = options?.enabled ?? configured;
  const isAttached = options?.isAttached ?? (() => true);
  const now = options?.now ?? Date.now;
  const epoch = options?.epoch ?? "";
  const hubCaps = options?.hubCaps ?? (() => []);
  const hubHasDialogBg = (): boolean => {
    try {
      const caps = hubCaps();
      return DIALOG_BG_HUB_CAPS.some((cap) => caps.includes(cap));
    } catch {
      return false;
    }
  };
  const records = new Map<string, DialogRecord>();
  let closed: DialogClosedWire[] = [];
  let disposed = false;

  const prune = (): void => {
    const cutoff = now() - CLOSED_TTL_MS;
    closed = closed.filter((entry) => entry.at >= cutoff).slice(-CLOSED_LIMIT);
  };
  const publish = (): void => {
    prune();
    try {
      options?.setSlot?.("dialogs", frame());
    } catch {
      /* slot sinks are best-effort and must never break ask_user */
    }
  };
  const frame = (): DialogsFrame => {
    prune();
    return {
      t: "dialogs",
      epoch,
      open: [...records.values()]
        .filter((record) => record.state === "open")
        .map((record) => ({
          ...record.wire,
          questions: record.wire.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option })),
          })),
        })),
      // ask-user-async §7.2 (P3): the by:"background" → "abort" downgrade happens HERE, at the
      // wire boundary only — `closed` above keeps the original value so a hub upgrade (cap
      // advertised on reconnect) re-emits the same record as "background" within its TTL.
      closed: closed.map((entry) =>
        entry.by === "background" && !hubHasDialogBg() ? { ...entry, by: "abort" as const } : { ...entry },
      ),
    };
  };

  const finish = (
    record: DialogRecord,
    by: DialogClosedWire["by"],
    outcome: DialogClosedWire["outcome"],
    cmdId?: string,
  ): void => {
    if (record.state !== "open") return;
    record.state = "closed";
    closed.push({
      dialogId: record.id,
      by,
      outcome,
      ...(cmdId === undefined ? {} : { cmdId }),
      at: now(),
    });
    publish();
  };

  const lookup = (dialogId: string, expectedEpoch?: string): DialogRecord | undefined => {
    if (expectedEpoch !== undefined && expectedEpoch !== epoch) return undefined;
    return records.get(dialogId);
  };

  const answer = (
    dialogId: string,
    answers: DialogAnswerWire[],
    origin: string | CmdOrigin = "remote",
    cmdId?: string,
    expectedEpoch?: string,
  ): CmdResultBody => {
    if (expectedEpoch !== undefined && expectedEpoch !== epoch) return failure("E_DIALOG_CLOSED", "stale", false);
    const record = lookup(dialogId);
    if (record === undefined || record.state !== "open") return failure("E_DIALOG_CLOSED", "closed", false);
    const invalid = validAnswers(record, answers);
    if (invalid !== undefined) return failure("E_BAD_ANSWER", invalid, false);
    const callback = record.onRemote;
    if (callback === undefined) return failure("E_DIALOG_CLOSED", "closed", false);
    let claimed = false;
    try {
      claimed = callback({
        kind: "answer",
        answers: encodeAnswers(record.request.questions, answers),
        origin: originText(origin),
      });
    } catch {
      claimed = false;
    }
    if (!claimed) return failure("E_DIALOG_CLOSED", "closed", false);
    finish(record, "web", "answered", cmdId);
    options?.notify?.(`ask_user answered by web (${originText(origin)})`);
    return success("dialog_answer");
  };

  const cancel = (
    dialogId: string,
    origin: string | CmdOrigin = "remote",
    cmdId?: string,
    expectedEpoch?: string,
  ): CmdResultBody => {
    if (expectedEpoch !== undefined && expectedEpoch !== epoch) return failure("E_DIALOG_CLOSED", "stale", false);
    const record = lookup(dialogId);
    if (record === undefined || record.state !== "open") return failure("E_DIALOG_CLOSED", "closed", false);
    if (!record.request.allowCancel) return failure("E_BAD_ANSWER", "cancellation is not allowed", false);
    const callback = record.onRemote;
    if (callback === undefined) return failure("E_DIALOG_CLOSED", "closed", false);
    let claimed = false;
    try {
      claimed = callback({ kind: "cancel", origin: originText(origin) });
    } catch {
      claimed = false;
    }
    if (!claimed) return failure("E_DIALOG_CLOSED", "closed", false);
    finish(record, "web", "cancelled", cmdId);
    options?.notify?.(`ask_user cancelled by web (${originText(origin)})`);
    return success("dialog_cancel");
  };

  const open = (request: {
    toolCallId: string;
    questions: AskUserQuestion[];
    allowCancel: boolean;
  }): AskUserRemoteSession | undefined => {
    if (disposed || !enabled) return undefined;
    try {
      if (!isAttached()) return undefined;
    } catch {
      return undefined;
    }
    const id = `ask:${request.toolCallId}`;
    const record: DialogRecord = {
      id,
      request: {
        toolCallId: request.toolCallId,
        questions: request.questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({ ...option })),
        })),
        allowCancel: request.allowCancel,
      },
      wire: {
        dialogId: id,
        source: "ask_user",
        toolCallId: request.toolCallId,
        questions: request.questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({ ...option })),
        })),
        allowCancel: request.allowCancel,
        openedAt: now(),
      },
      state: "open",
      attributed: false,
    };
    records.set(id, record);
    publish();
    let closedLocally = false;
    return {
      setOnRemote(fn) {
        if (closedLocally || record.state !== "open") return;
        record.onRemote = fn;
      },
      close(by, outcome) {
        if (closedLocally) return;
        closedLocally = true;
        finish(record, by, outcome);
      },
    };
  };

  const handle = (input: CmdFrame): CmdResultBody | undefined => {
    const cmd = input.cmd;
    let result: CmdResultBody | undefined;
    if (cmd.op === "dialog_answer") result = answer(cmd.dialogId, cmd.answers, input.origin, input.id, cmd.epoch);
    else if (cmd.op === "dialog_cancel") result = cancel(cmd.dialogId, input.origin, input.id, cmd.epoch);
    else return undefined;
    options?.send?.({ t: "cmd_result", rid: input.rid, id: input.id, ...result });
    return result;
  };

  const detachAll = (): void => {
    for (const record of records.values()) finish(record, "session", "aborted");
    publish();
  };

  const attributePrompt = (event: WireEvent): WireEvent => {
    const kind = event.kind;
    const title = event.title;
    const isRpcMarker = kind === "select" && title === ASK_USER_MARKER;
    const candidate = [...records.values()].find(
      (record) => record.state === "open" && !record.attributed && (kind === "custom" || isRpcMarker),
    );
    if (candidate === undefined) {
      return isRpcMarker ? { ...event, title: "ask_user" } : event;
    }
    candidate.attributed = true;
    return { ...event, ...(isRpcMarker ? { title: "ask_user" } : {}), dialogId: candidate.id };
  };

  return {
    open,
    frame,
    handle,
    answer,
    cancel,
    detachAll,
    attributePrompt,
    dispose() {
      if (disposed) return;
      disposed = true;
      detachAll();
    },
  };
}
