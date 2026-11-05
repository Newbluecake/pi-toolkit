// #34 T-S1 (plan §7.4): field-level proof that fabric-OFF sees only the declared wording changes.
// The PRE34_* constants were captured verbatim on T0 = bf7173890da800f9c53a48a7c0da2d875b4bad36 BEFORE any
// #34 source change (a one-off dump of createSteerTool({ query, fabricEnabled: () => false });
// dump sha256 16bde59f470e86bb8918faf07fe0a9c0e62d3c70b4baa43d3d58fd63a8efd18e). Only DECLARED_SUBS may
// differ; P2 appended the third entry (the setting-key rename) and rewrote the residual assertion —
// nothing else differs from the P1 capture.
import { describe, expect, it } from "vitest";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import type { QueryService } from "../../src/service/query-service.js";

const PRE34_NAME = "steer_subagent";
const PRE34_LABEL = "Steer Subagent";
const PRE34_DESCRIPTION =
  'Send a follow-up instruction to a currently running subagent started with the Agent tool. With reply="ack"/"report" the subagent also answers back once via message_agent (kind "finding") — the answer arrives in your context as a subagent:fabric message, so end your turn instead of polling.';
const PRE34_REPLY_DESCRIPTION =
  'none (default): deliver the text as-is. "ack": the subagent first replies ONE short confirmation (received + how it will adjust). "report": it first replies a concise progress report (done so far / doing now / blockers / ETA, ≤10 lines). Replies are sent with message_agent (to "root", kind "finding") and arrive in your context as a subagent:fabric message after the subagent\'s next turn — end your turn instead of polling. Needs fabric (message_agent); without it, or for an external-agent run, the text is delivered verbatim (no reply). Findings are per-run quota limited (fabric.findingQuota, default 10) — a reply over quota is dropped.';
const PRE34_RUN_ID_DESC =
  "The run id of the subagent to steer; also accepts a unique run_id prefix or the Agent call's label (its description).";
const PRE34_TEXT_DESC = "The follow-up instruction to send to the running subagent.";
const PRE34_PROMPT_SNIPPET =
  "steer_subagent(run_id, text, reply?) - send a follow-up instruction to a running subagent; reply=ack|report asks it to answer back via message_agent";
const PRE34_PARAMS_SKELETON = {
  type: "object",
  required: ["run_id", "text"],
  properties: {
    run_id: {
      type: "string",
    },
    text: {
      type: "string",
    },
    reply: {
      anyOf: [
        {
          const: "none",
          type: "string",
        },
        {
          const: "ack",
          type: "string",
        },
        {
          const: "report",
          type: "string",
        },
      ],
    },
  },
} as { [k: string]: unknown };
const PRE34_OFF_RESULTS = {
  none: {
    content: [
      {
        type: "text",
        text: "Sent follow-up instruction to run r9.",
      },
    ],
    details: {
      ok: true,
      runId: "r9",
    },
  },
  ack: {
    content: [
      {
        type: "text",
        text: "Sent follow-up instruction to run r9. reply 不可用：fabric 未启用，已按普通 steer 送达（文本原样转发，不会收到回复消息）。",
      },
    ],
    details: {
      ok: true,
      runId: "r9",
      reply: "ack",
      replyFramed: false,
    },
  },
  report: {
    content: [
      {
        type: "text",
        text: "Sent follow-up instruction to run r9. reply 不可用：fabric 未启用，已按普通 steer 送达（文本原样转发，不会收到回复消息）。",
      },
    ],
    details: {
      ok: true,
      runId: "r9",
      reply: "report",
      replyFramed: false,
    },
  },
} as Record<string, unknown>;

/** Task-complete (P2) stage (plan §7.4 table): the three declared replacements, in order. */
const DECLARED_SUBS: readonly (readonly [string, string])[] = [
  ['kind "finding"', 'kind "report"'],
  ["Findings are", "Reports are"],
  ["fabric.findingQuota", "fabric.reportQuota"],
];

const applySubs = (text: string, subs: readonly (readonly [string, string])[]): string =>
  subs.reduce((t, [from, to]) => t.split(from).join(to), text);
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
/** The bare old kind word, derived from DECLARED_SUBS — used only as a needle for the zero-residual assertions. */
const OLD_KIND_WORD = /kind "(.+?)"/.exec(DECLARED_SUBS[0]![0])![1]!;
/** The old setting key and its renamed replacement, likewise derived from DECLARED_SUBS. */
const OLD_QUOTA_KEY = DECLARED_SUBS[2]![0];
const NEW_QUOTA_KEY = DECLARED_SUBS[2]![1];

const query = (steer: QueryService["steer"]): QueryService => ({
  get: () => undefined,
  list: () => [],
  wait: async () => ({ ok: false, reason: "unknown_run" }),
  waitAll: async () => ({ settled: [], pending: [] }),
  steer,
  stop: async () => false,
});

/** Same recursive strip as the capture: drop every `description` key, keep key order. */
function skeleton(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(skeleton);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (k !== "description") out[k] = skeleton(v);
    return out;
  }
  return value;
}

describe("#34 T-S1: steer_subagent fabric-off surface changes only by DECLARED_SUBS (P2 stage)", () => {
  const tool = createSteerTool({ query: query(async () => ({ ok: true })), fabricEnabled: () => false });
  const props = (tool.parameters as unknown as Record<string, { description?: string }>).properties ?? {};

  it("unchanged surfaces are deep-equal to PRE34", async () => {
    expect(tool.name).toBe(PRE34_NAME);
    expect(tool.label).toBe(PRE34_LABEL);
    expect(tool.promptSnippet).toBe(PRE34_PROMPT_SNIPPET);
    expect(skeleton(tool.parameters)).toEqual(PRE34_PARAMS_SKELETON);
    expect(Object.keys(skeleton(tool.parameters) as object)).toEqual(Object.keys(PRE34_PARAMS_SKELETON));
    expect(props.run_id?.description).toBe(PRE34_RUN_ID_DESC);
    expect(props.text?.description).toBe(PRE34_TEXT_DESC);
    for (const reply of ["none", "ack", "report"] as const) {
      const out = await tool.execute("t34", { run_id: "r9", text: "x", ...(reply === "none" ? {} : { reply }) });
      expect({ content: out.content, details: out.details }).toEqual(PRE34_OFF_RESULTS[reply]);
    }
  });

  it("description and reply.description equal PRE34 + DECLARED_SUBS, with the pinned replacement counts", () => {
    // P2 replacement counts, pinned on the PRE34 originals (plan §7.4 table row "P2").
    expect(occurrences(PRE34_DESCRIPTION, DECLARED_SUBS[0]![0])).toBe(1);
    expect(occurrences(PRE34_DESCRIPTION, DECLARED_SUBS[1]![0])).toBe(0);
    expect(occurrences(PRE34_DESCRIPTION, DECLARED_SUBS[2]![0])).toBe(0);
    expect(occurrences(PRE34_REPLY_DESCRIPTION, DECLARED_SUBS[0]![0])).toBe(1);
    expect(occurrences(PRE34_REPLY_DESCRIPTION, DECLARED_SUBS[1]![0])).toBe(1);
    expect(occurrences(PRE34_REPLY_DESCRIPTION, DECLARED_SUBS[2]![0])).toBe(1);
    expect(tool.description).toBe(applySubs(PRE34_DESCRIPTION, DECLARED_SUBS));
    expect(props.reply?.description).toBe(applySubs(PRE34_REPLY_DESCRIPTION, DECLARED_SUBS));
  });

  it("residuals: no old kind wording and no old setting key anywhere; the new key appears exactly once", () => {
    const surfaces = [
      tool.description,
      props.reply?.description ?? "",
      tool.name,
      tool.label,
      tool.promptSnippet,
      props.run_id?.description ?? "",
      props.text?.description ?? "",
      JSON.stringify(skeleton(tool.parameters)),
      JSON.stringify(PRE34_OFF_RESULTS),
    ];
    for (const text of surfaces) {
      expect(text.toLowerCase().includes(OLD_KIND_WORD)).toBe(false);
      expect(text.includes(OLD_QUOTA_KEY)).toBe(false);
    }
    expect(occurrences(props.reply?.description ?? "", NEW_QUOTA_KEY)).toBe(1);
  });
});
