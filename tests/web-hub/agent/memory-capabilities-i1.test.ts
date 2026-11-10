import { expect, it } from "vitest";
import { createCommandComplete } from "../../../src/web-hub/agent/command-complete.js";
import { resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";
import type { MemoryWebCapabilities } from "../../../src/memory/scopes/web-write-port.js";

const states: [string, MemoryWebCapabilities, string[]][] = [
  ["session-only", { sessionAdd: true, revisionReview: true }, ["session add text", "review", "review --list"]],
  ["hub-only", { sessionAdd: false, revisionReview: true }, ["review", "review --list"]],
  ["all-off", { sessionAdd: false, revisionReview: false }, []],
  ["no-actual-owner", { sessionAdd: false, revisionReview: false }, []],
];
function complete(capabilities: () => MemoryWebCapabilities, wait?: Promise<void>) {
  return createCommandComplete({
    commands: { getCommands: () => [{ name: "mem", source: "extension", description: "memory" }] },
    own: () =>
      new Map([
        [
          "mem",
          async () => {
            await wait;
            return ["session add text", "review", "review --list", "hub add text"].map((value) => ({
              value,
              label: value,
            }));
          },
        ],
      ]),
    tui: () => undefined,
    mode: "toolkit",
    memoryScopes: true,
    memoryCapabilities: capabilities,
    overrides: { mem: "allow" },
  });
}
it.each(states)(
  "%s completion/policy uses actual per-operation capability, never facade existence",
  async (_name, caps, expected) => {
    const c = complete(() => caps);
    try {
      const result = await c.answer({
        t: "complete_req",
        deadlineMs: 1000,
        origin: { listener: "loopback" },
        rid: "i1-cap",
        name: "mem",
        prefix: "",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error("actual complete failed");
      expect(result.items.map((row) => row.value)).toEqual(expected);
      for (const args of ["review", "review --list"])
        expect(
          resolveCommandPolicy({
            name: "mem",
            args,
            kind: "extension",
            memoryScopes: true,
            memorySessionAdd: caps.sessionAdd,
            memoryRevisionReview: caps.revisionReview,
          }).policy,
        ).toBe(caps.revisionReview ? "allow" : "deny");
    } finally {
      c.dispose();
    }
  },
);
it("capability loss during actual completer await cannot publish stale true; unknown and throwing queries are false", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let caps = { sessionAdd: true, revisionReview: true };
  const c = complete(() => caps, wait);
  const promise = c.answer({
    t: "complete_req",
    deadlineMs: 1000,
    origin: { listener: "loopback" },
    rid: "i1-loss",
    name: "mem",
    prefix: "",
  });
  caps = { sessionAdd: false, revisionReview: false };
  release();
  const result = await promise;
  expect(result).toMatchObject({ ok: true, items: [] });
  c.dispose();
  const throwing = complete(() => {
    throw Error("unknown actual context");
  });
  expect(
    await throwing.answer({
      t: "complete_req",
      deadlineMs: 1000,
      origin: { listener: "loopback" },
      rid: "i1-unknown",
      name: "mem",
      prefix: "",
    }),
  ).toMatchObject({ ok: true, items: [] });
  throwing.dispose();
});
