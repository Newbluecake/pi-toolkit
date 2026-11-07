import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_BIND_EVENT,
  receiveMemoryChildBinding,
  type MemoryBindRequest,
} from "../../../src/memory/scopes/child-bind.js";

function bus() {
  const handlers = new Map<string, (value: unknown) => void>();
  return {
    on(name: string, fn: (value: unknown) => void) {
      handlers.set(name, fn);
      return () => {
        handlers.delete(name);
      };
    },
    emit(value: unknown) {
      handlers.get(MEMORY_BIND_EVENT)?.(value);
    },
    handlers,
  };
}
describe("memory child receiver exact ownership", () => {
  it("same actual manager/incarnation is idempotent; foreign and late bind cannot replace it", () => {
    const b = bus(),
      release = vi.fn(),
      bind = vi.fn(() => release);
    const off = receiveMemoryChildBinding(b, bind);
    const reply = vi.fn();
    const manager = {
      getSessionId: () => "sid",
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getBranch: () => [],
      appendCustomEntry() {},
    };
    const request: MemoryBindRequest = {
      v: 1,
      owner: { runId: "run", incarnation: {} },
      manager,
      reason: "created",
      reply,
    };
    b.emit(request);
    b.emit(request);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0]).toBe(reply.mock.calls[1]![0]);
    b.emit({ ...request, owner: { runId: "run", incarnation: {} }, reply: vi.fn() });
    expect(bind).toHaveBeenCalledTimes(1);
    off();
    off();
    expect(release).toHaveBeenCalledTimes(1);
    expect(b.handlers.size).toBe(0);
    b.emit(request);
    expect(reply).toHaveBeenCalledTimes(2);
  });
});
