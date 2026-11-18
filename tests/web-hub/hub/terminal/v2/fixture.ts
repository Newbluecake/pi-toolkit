import { vi } from "vitest";
import type { AuthIdentity } from "../../../../../src/web-hub/hub/auth-identity.js";
import type {
  TerminalRuntimeV2,
  TerminalServiceV2,
  TerminalViewSinkV2,
} from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import type { TerminalHttpRequestsV2, TerminalViewFrameV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
import { TerminalRevocationFenceV2 } from "../../../../../src/web-hub/hub/terminal/v2/revocation-fence.js";
import { createTerminalViewsV2, type TerminalRevalidateV2 } from "../../../../../src/web-hub/hub/terminal/v2/view.js";
import { createTerminalResizeGateV2 } from "../../../../../src/web-hub/hub/terminal/v2/resize-gate.js";
export const hubInstance = "h".repeat(24),
  termId = "t".repeat(24);
export const scope = { agentKey: "a".repeat(24), sessionId: "session", epoch: "epoch" };
export const envelope = { hubInstance, scope, termId };
export const identity = (): AuthIdentity => ({
  listener: "loopback",
  principal: "p",
  sidTag: "s",
  parentExpiresAt: Date.now() + 1_000_000,
});
export const signal = () => new AbortController().signal;
export function fixture(initial = Buffer.alloc(0)) {
  let bytes = initial;
  const invalidated = new AbortController();
  const subscribers = new Set<() => void>();
  const runtime: TerminalRuntimeV2 = {
    termId,
    invalidated: invalidated.signal,
    metadata: { cwd: "/isolated", shellName: "bash", userLabel: "fixture", hostLabel: "fixture" },
    current: vi.fn(() => !invalidated.signal.aborted),
    snapshot: () => ({ start: 0, end: bytes.length, state: "live" }),
    read: vi.fn((offset, maxBytes) => {
      const start = Math.max(offset, bytes.length - maxBytes);
      const chunks: Array<{ offset: number; bytesB64: string }> = [];
      for (let n = start; n < bytes.length; n += 8192)
        chunks.push({ offset: n, bytesB64: bytes.subarray(n, Math.min(bytes.length, n + 8192)).toString("base64") });
      return { start, end: bytes.length, chunks };
    }),
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    write: vi.fn(async () => ({ ok: true as const })),
    resize: vi.fn(async () => ({ ok: true as const })),
  };
  const dimension = { used: 1, unknown: 0, limit: 2 };
  const service: TerminalServiceV2 = {
    runtime: vi.fn(async () => ({ ok: true, runtime })),
    list: vi.fn(async () => ({
      ok: true,
      hubInstance,
      revision: 1,
      rows: [],
      unknownResources: [],
      quota: { session: dimension, principal: dimension, total: { ...dimension, limit: 8 } },
    })),
    create: vi.fn(async (_auth, _scope, input) => ({ ok: true, requestId: input.requestId, termId, state: "live" })),
    creation: vi.fn(async () => ({ ok: true, outcome: "unknown" })),
    rename: vi.fn(async (_auth, input) => ({
      ok: true,
      row: { termId, name: input.name.trim(), createdAt: 0, ordinal: 1, state: "live" },
      revision: 2,
    })),
    close: vi.fn(async () => ({ ok: true, state: "closing", revision: 2 })),
    retireScope: vi.fn(),
    dispose: vi.fn(async () => ({ clean: true, unresolved: 0 })),
  };
  const fence = new TerminalRevocationFenceV2();
  const revalidate = vi.fn<TerminalRevalidateV2>(async (id) => ({ ok: true, identity: { ...id } }));
  const resizeGate = createTerminalResizeGateV2();
  const views = createTerminalViewsV2({
    service,
    auth: fence,
    notifications: fence,
    hubInstance,
    revalidate,
    resizeGate,
  });
  const id = identity();
  const frames: TerminalViewFrameV2[] = [];
  const sink: TerminalViewSinkV2 = {
    send: vi.fn((frame) => {
      frames.push(frame);
      return true;
    }),
    close: vi.fn(),
  };
  async function open(input: Partial<TerminalHttpRequestsV2["view"]> = {}) {
    const result = await views.open(id, { ...envelope, ...input }, signal());
    if (!result.ok) throw new Error(result.code);
    result.view.start(sink);
    await vi.advanceTimersByTimeAsync(10);
    return { view: result.view, writer: { ...envelope, viewId: result.view.viewId } };
  }
  return {
    runtime,
    invalidated,
    service,
    fence,
    views,
    revalidate,
    resizeGate,
    id,
    frames,
    sink,
    open,
    append(chunk: Buffer) {
      bytes = Buffer.concat([bytes, chunk]);
      for (const fn of subscribers) fn();
    },
    dispose() {
      views.dispose();
      fence.dispose();
    },
  };
}
