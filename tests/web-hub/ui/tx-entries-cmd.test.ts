import { describe, expect, it } from "vitest";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";
import type { Item } from "../../../src/web-hub/ui/src/types.js";
import { cmdEndRecord, cmdItem, cmdRecord, notify } from "./fixtures/cmd-records.js";

/** U1 · transcript/entries.ts fold integration (plan §4.2/§4.7): card position = first
 *  occurrence; surplus entries (the ends, when a start hosts) contribute NO TxEntry;
 *  renderKeys carry the foldSig (last end id + resolved state) so the card refreshes in
 *  place; start-only cards resolve against the injected live context. */

const ID = "c0123456789abcdef012";

function source(items: Item[]): TranscriptSource {
  return {
    key: "agent-a",
    items,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
  };
}

const start = (id = "e1", cmdId = ID) => cmdItem(id, cmdRecord({ cmdId })) as unknown as Item;
const end = (id = "e2", cmdId = ID, over: Record<string, unknown> = {}) =>
  cmdItem(id, cmdEndRecord({ cmdId, ...over })) as unknown as Item;

describe("buildTxEntries — command cards", () => {
  it("start+end ⇒ ONE command entry at the start's index; the end row contributes nothing", () => {
    const b = buildTxEntries(source([start(), end()]));
    expect(b.entries.map((e) => e.type)).toEqual(["command"]);
    expect(b.entries[0]?.key).toBe("e:e1:0");
    const view = (b.entries[0] as { view: { state: string } }).view;
    expect(view.state).toBe("done");
    expect(b.anchors).toEqual([["e:e1"]]);
  });

  it("end-only ⇒ card at the end's position", () => {
    const b = buildTxEntries(source([end("e5")]));
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]?.key).toBe("e:e5:0");
    expect(b.anchors[0]).toEqual(["e:e5"]);
  });

  it("renderKey carries the foldSig and changes when the end lands / state flips", () => {
    const onlyStart = buildTxEntries(source([start()]));
    const withEnd = buildTxEntries(source([start(), end()]));
    expect(onlyStart.renderKeys[0]).toBe("e:e1:0|cmd::unrecorded"); // no live ctx ⇒ unrecorded
    expect(withEnd.renderKeys[0]).toBe("e:e1:0|cmd:e2:done");
    expect(onlyStart.renderKeys[0]).not.toBe(withEnd.renderKeys[0]);
  });

  it("live context resolves start-only cards (running set / seen grace / unrecorded)", () => {
    const items = [start()];
    const running = buildTxEntries(source(items), { running: new Set([ID]), now: 1000 });
    expect((running.entries[0] as { view: { state: string } }).view.state).toBe("running");
    const grace = buildTxEntries(source(items), {
      running: new Set(),
      seenRunningAt: () => 1000,
      now: 2000,
    });
    expect((grace.entries[0] as { view: { state: string } }).view.state).toBe("running");
    const stale = buildTxEntries(source(items), { running: new Set(), seenRunningAt: () => 1000, now: 99_000 });
    expect((stale.entries[0] as { view: { state: string } }).view.state).toBe("unrecorded");
    // no live context at all (drawer) ⇒ unrecorded, never a dead-running card
    const none = buildTxEntries(source(items));
    expect((none.entries[0] as { view: { state: string } }).view.state).toBe("unrecorded");
  });

  it("a cancelled session-leave's second end wins and is hidden", () => {
    const b = buildTxEntries(
      source([
        start(),
        end("e2", ID, { state: "done", notice: "left-session" }),
        end("e3", ID, { state: "failed", error: "cancelled" }),
      ]),
    );
    expect(b.entries).toHaveLength(1);
    const view = (b.entries[0] as { view: { state: string; error?: string } }).view;
    expect(view.state).toBe("failed");
    expect(view.error).toBe("cancelled");
    expect(b.renderKeys[0]).toBe("e:e1:0|cmd:e3:failed");
  });

  it("cmd cards interleave with other entries; anchors stay index-aligned", () => {
    const user: Item = {
      id: "e:m1:3",
      kind: "message",
      entryId: "m1",
      message: { role: "user", content: "hi", timestamp: 42 },
    };
    const b = buildTxEntries(source([user, start(), end()]));
    expect(b.entries.map((e) => e.type)).toEqual(["user", "command"]);
    expect(b.anchors[0]).toEqual(["e:m1", "k:user:42"]);
    expect(b.anchors[1]).toEqual(["e:e1"]);
  });

  it("an ended card keeps its output for rendering", () => {
    const b = buildTxEntries(source([end("e2", ID, { output: { entries: [notify("done!")] } })]));
    const view = (b.entries[0] as { view: { output?: { entries: unknown[] } } }).view;
    expect(view.output?.entries).toHaveLength(1);
  });
});
