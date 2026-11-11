import { describe, expect, it, vi } from "vitest";
import { completeThreadArguments, createThreadCommand } from "../../src/commands/thread.js";

describe("thread argument completion", () => {
  const complete = (prefix: string, rebind = false) => completeThreadArguments(prefix, { rebind });
  const values = (prefix: string, rebind = false) => complete(prefix, rebind).map((item) => item.value);

  it("returns ordered roots according to the rebind gate", () => {
    expect(values("")).toEqual(["status", "help", "sub", "drop"]);
    expect(values("", true)).toEqual(["status", "help", "sub", "drop", "rebind", "acquire"]);
    expect(values("s")).toEqual(["status", "sub"]);
    expect(values("r")).toEqual([]);
    expect(values("r", true)).toEqual(["rebind"]);
  });

  it("offers origin only in the specified positions and preserves the full prefix", () => {
    expect(complete("sub r_EXAMPLE ")).toEqual([{ value: "sub r_EXAMPLE origin", label: "origin" }]);
    expect(values("sub\t@worker\tor")).toEqual(["sub\t@worker\torigin"]);
    expect(values("rebind o", true)).toEqual(["rebind origin"]);
    expect(values("acquire ", true)).toEqual(["acquire origin"]);
    for (const prefix of [
      "sub ",
      "sub run other",
      "sub run origin ",
      "drop ",
      "drop id",
      "status ",
      "help x",
      "rebind origin ",
      "acquire origin x",
      "sub run origin scope",
      " rebind",
    ]) {
      expect(values(prefix, true), prefix).toEqual([]);
    }
    expect(values("rebind ")).toEqual([]);
    expect(values("acquire o")).toEqual([]);
  });

  it("rejects control characters and bounds both input and output bytes", () => {
    for (const prefix of ["s\n", "sub run \u0000", "s\u007f", "a".repeat(1025)])
      expect(values(prefix, true)).toEqual([]);
    expect(values(`sub ${"é".repeat(252)} `)).toEqual([]);
    expect(values(`sub ${"a".repeat(500)} `)[0]).toHaveLength(511);
    expect(values("sub <run> ")).toEqual(["sub <run> origin"]);
  });

  it("keeps the existing unavailable handler when no ops exist", async () => {
    const notify = vi.fn();
    const command = createThreadCommand({ current: () => undefined });
    await command.handler("sub run origin", { ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith(
      "thread 订阅未开启（fabric.threads.enabled=false）或当前无活跃会话栈。",
      "warning",
    );
  });

  it("uses no live operations, with or without an active ops object", async () => {
    const ops = new Proxy(
      {},
      {
        get: () => {
          throw new Error("ops read");
        },
      },
    );
    for (const rebind of [false, true]) {
      for (const currentValue of [undefined, ops]) {
        const current = vi.fn(() => currentValue) as unknown as Parameters<typeof createThreadCommand>[0]["current"];
        const command = createThreadCommand({ current, rebind });
        for (const prefix of ["", "s", "sub run ", "rebind o", "acquire "]) {
          expect(await command.getArgumentCompletions!(prefix)).toEqual(complete(prefix, rebind));
        }
        expect(current).not.toHaveBeenCalled();
      }
    }
  });
});
