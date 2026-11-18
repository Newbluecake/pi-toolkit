import { vi } from "vitest";
import type {
  TerminalHttpRequestsV2,
  TerminalHttpResponseV2,
  TerminalQuotaV2,
  TerminalTabRowV2,
  TerminalUnknownResourceV2,
  TerminalViewFrameV2,
} from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
import type { TerminalJsonOpV2 } from "../../../src/web-hub/ui/src/logic/terminal-v2.js";
import { TerminalViewErrorV2, type TerminalTransportV2 } from "../../../src/web-hub/ui/src/transport/terminal-v2.js";

export const scopeV2 = { agentKey: "agent", sessionId: "session", epoch: "epoch" } as const;
export const hubV2 = "H".repeat(22);
export const termV2 = "T".repeat(22);
export const viewV2 = "V".repeat(22);
export const requestV2 = "R".repeat(22);

export const quotaV2: TerminalQuotaV2 = {
  session: { used: 1, unknown: 0, limit: 2 },
  principal: { used: 1, unknown: 0, limit: 2 },
  total: { used: 1, unknown: 0, limit: 8 },
};

export function rowV2(termId = termV2, ordinal = 1): TerminalTabRowV2 {
  return { termId, name: `bash ${ordinal}`, state: "live", createdAt: 1, ordinal };
}

type AnyRequestV2 = TerminalHttpRequestsV2[TerminalJsonOpV2];
type AnyResponseV2 = TerminalHttpResponseV2<TerminalJsonOpV2>;
export type RequestHandlerV2 = (
  op: TerminalJsonOpV2,
  body: AnyRequestV2,
) => AnyResponseV2 | undefined | Promise<AnyResponseV2 | undefined>;

export interface MockViewV2 {
  body: TerminalHttpRequestsV2["view"];
  onFrame(frame: TerminalViewFrameV2): void;
  signal: AbortSignal;
  emit(frame: TerminalViewFrameV2): void;
  finish(): void;
  fail(error?: Error): void;
}

export function createTerminalMockV2(handler?: RequestHandlerV2) {
  const rows = [rowV2()];
  const unknownResources: TerminalUnknownResourceV2[] = [];
  const quota: TerminalQuotaV2 = structuredClone(quotaV2);
  const creations = new Map<string, string>();
  let revision = 1;
  let nextTerminal = 1;
  const requestHandler: RequestHandlerV2 = async (op, body) => {
    if (handler) {
      const override = await handler(op, body);
      if (override) return override;
    }
    if (op === "list") {
      return {
        ok: true,
        hubInstance: hubV2,
        revision,
        rows: rows.map((row) => ({ ...row })),
        unknownResources: unknownResources.map((row) => ({ ...row })),
        quota: structuredClone(quota),
      };
    }
    if (op === "create" && "requestId" in body) {
      const termId = `T${String(nextTerminal++).padStart(21, "0")}`;
      creations.set(body.requestId, termId);
      if (!rows.some((row) => row.termId === termId)) rows.push(rowV2(termId, rows.length + 1));
      revision++;
      return { ok: true, requestId: body.requestId, termId, state: "live" };
    }
    if (op === "creation" && "requestId" in body) {
      const termId = creations.get(body.requestId);
      return termId ? { ok: true, outcome: "created", termId } : { ok: true, outcome: "unknown" };
    }
    if (op === "rename" && "termId" in body && "name" in body) {
      const row = rows.find((item) => item.termId === body.termId);
      if (!row) return { ok: false, code: "E_NOT_FOUND", effect: "none" };
      row.name = body.name.trim();
      revision++;
      return { ok: true, row: { ...row }, revision };
    }
    if (op === "close" && "termId" in body) {
      const index = rows.findIndex((item) => item.termId === body.termId);
      if (index >= 0) rows.splice(index, 1);
      revision++;
      return { ok: true, state: "closed", revision };
    }
    if ((op === "input" || op === "resize") && "seq" in body) return { ok: true, acceptedThrough: body.seq };
    if (op === "ack" && "offset" in body) return { ok: true, offset: body.offset };
    return { ok: false, code: "E_BAD_REQUEST", effect: "none" };
  };
  const request = vi.fn(requestHandler);
  const views: MockViewV2[] = [];
  const view = vi.fn((body: TerminalHttpRequestsV2["view"], onFrame: (frame: TerminalViewFrameV2) => void) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let signal!: AbortSignal;
    const entry: MockViewV2 = {
      body,
      onFrame,
      signal: undefined as unknown as AbortSignal,
      emit: (frame) => onFrame(frame),
      finish: () => resolve(),
      fail: (error = new TerminalViewErrorV2("E_UNAVAILABLE", "unknown")) => reject(error),
    };
    views.push(entry);
    return {
      promise,
      register(actualSignal?: AbortSignal) {
        signal = actualSignal ?? new AbortController().signal;
        entry.signal = signal;
        signal.addEventListener("abort", () => reject(new TerminalViewErrorV2("E_DEADLINE", "unknown")), {
          once: true,
        });
      },
    };
  });
  const transport: TerminalTransportV2 = {
    request: request as unknown as TerminalTransportV2["request"],
    async view(body, onFrame, signal) {
      const controlled = view(body, onFrame);
      controlled.register(signal);
      return controlled.promise;
    },
  };
  return { transport, request, view, views, rows, unknownResources, quota, creations };
}

export function attachedFrameV2(termId = termV2, start = 0, end = 0): TerminalViewFrameV2 {
  return {
    t: "attached",
    hubInstance: hubV2,
    viewId: viewV2,
    termId,
    start,
    end,
    metadata: { cwd: "/work", shellName: "bash", userLabel: "user", hostLabel: "host" },
  };
}

export async function turnV2(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}
