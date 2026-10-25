/**
 * web-hub 命令历史 U1 (docs/dev/web-hub-cmd-history/plan.md v2 §4.1/§4.7) — shared fixtures.
 *
 * Factories for the PROJECTED wire shapes the UI consumes: a `WireEntry` custom tombstone
 * carrying a sanitized `cmd` field (what hub `projectSessionEntry` emits for a
 * `subagent:cmd` entry), and the `@logic/state.js` `Item` (`kind:"cmd"`) the reducer's
 * `entryItem` turns it into. Tests import these instead of hand-rolling records so the
 * matrix (start/end phases, sources, notices, budgets) is written once.
 */

let seq = 0;

/** A minimal valid CmdRecordData-shaped body (start phase). Override freely. */
export function cmdRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    v: 1,
    cmdId: `cmd-${String(seq).padStart(14, "0")}`,
    phase: "start",
    name: "record",
    args: "status",
    source: "web",
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

/** End phase counterpart of `cmdRecord` (self-contained per §4.1). */
export function cmdEndRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return cmdRecord({
    phase: "end",
    endedAt: 1_700_000_001_000,
    state: "done",
    ...over,
  });
}

/** The projected WireEntry tombstone (`type:"custom"`, `display:false`, bounded `cmd`). */
export function cmdWireEntry(id: string, cmd: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "custom",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    customType: "subagent:cmd",
    display: false,
    dataKey: `subagent:cmd:${id}`,
    ...(cmd !== undefined ? { cmd } : {}),
  };
}

/** The reducer-level Item (`kind:"cmd"`) `entryItem` produces from a cmd wire entry. */
export function cmdItem(id: string, cmd: Record<string, unknown>, uid = 0): Record<string, unknown> {
  return { id: `e:${id}:${uid}`, kind: "cmd", entryId: id, entry: cmdWireEntry(id, cmd), truncated: false };
}

/** A plain user message wire entry (non-cmd neighbour in fold tests). */
export function userWireEntry(id: string, ts: number, text = "hi"): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

/** notify output entry shortcut. */
export function notify(text: string, level = "info"): Record<string, unknown> {
  return { kind: "notify", level, text };
}
