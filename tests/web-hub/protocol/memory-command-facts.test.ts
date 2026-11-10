import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  aggregateMemoryCommandEffect,
  encodeMemoryCommandFacts,
  MEMORY_FACTS_LIMITS,
  MEMORY_RESULT_CLOSE,
  MEMORY_RESULT_OPEN,
  memoryCommandFactsFailure,
  memoryCommandFailureCode,
  parseMemoryCommandFacts,
  type MemoryCommandFactRow,
  type MemoryCommandFacts,
} from "../../../src/web-hub/protocol/memory-command-facts.js";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { scanTier1Markers } from "../../tiers.js";

const CMD = "memory_command_0123456789";
const summary = "首步已完成，次步拒绝；不要盲目重试。";
const completed: MemoryCommandFactRow = {
  step: 1,
  actionId: "a".repeat(64),
  targetId: "rules.001",
  operation: "rewrite-single",
  outcome: "completed",
  receipt: "consumed",
  stage: "finalize",
  data: "applied",
  audit: "barrier-observed",
  review: "unchanged",
};
const rejected: MemoryCommandFactRow = {
  step: 2,
  targetId: "rules.002",
  operation: "retire",
  outcome: "rejected",
  receipt: "not-consumed",
  stage: "authorization",
  data: "not-called",
  audit: "not-entered",
  review: "unchanged",
  code: "E_MEM_CONFIRM_DECLINED",
};
function makeFacts(
  rows: readonly MemoryCommandFactRow[] = [completed, rejected],
  omitted: number | null = 0,
): MemoryCommandFacts {
  return { v: 1, kind: "memory-flow", cmdId: CMD, effect: aggregateMemoryCommandEffect(rows, omitted), rows, omitted };
}
function encoded(value: unknown = makeFacts(), text = summary): string {
  const result = encodeMemoryCommandFacts(text, value);
  expect(typeof result).toBe("string");
  return result!;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
function appendix(json: string, text = summary): string {
  return `${text}\n\n${MEMORY_RESULT_OPEN}\n${json}\n${MEMORY_RESULT_CLOSE}`;
}
const invalid = { kind: "invalid", effect: "unknown" };
function expectInvalid(json: string): void {
  expect(parseMemoryCommandFacts(appendix(json), CMD)).toEqual(invalid);
}

describe("memory facts canonical codec (display only)", () => {
  it("emits sorted canonical bytes and retains a readable host summary", () => {
    const value = makeFacts();
    const message = encoded(value);
    expect(message).toBe(appendix(canonical(value)));
    expect(parseMemoryCommandFacts(message, CMD)).toEqual({ kind: "facts", summary, facts: value });
    const parsed = parseMemoryCommandFacts(message, CMD);
    if (parsed.kind !== "facts") throw new Error("expected complete facts");
    expect(encodeMemoryCommandFacts(parsed.summary, parsed.facts)).toBe(message);
    expect(parsed.facts.effect).toBe("partial");
    expect(parsed.facts.rows[0]).toEqual(completed);
    expect(parsed.facts.rows[1]).toEqual(rejected);
  });

  it.each(["rewrite-single", "merge-survivor", "retire", "expires", "delete", "keep"] as const)(
    "accepts only explicit lifecycle tuples for %s (all other enum combinations are invalid)",
    (operation) => {
      type MatrixEntry = readonly [
        MemoryCommandFactRow["stage"],
        MemoryCommandFactRow["receipt"],
        readonly MemoryCommandFactRow["outcome"][],
        readonly MemoryCommandFactRow["data"][],
        readonly MemoryCommandFactRow["audit"][],
        readonly MemoryCommandFactRow["review"][],
      ];
      const unfinished = ["rejected", "skipped", "unknown"] as const;
      // Independent, explicit allow-list of the E/keep terminal observations. Not every
      // syntactically valid enum combination describes a possible lifecycle.
      const common: MatrixEntry[] = [
        ["admission", "not-consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
        ["plan", "not-consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
        ["authorization", "not-consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
        ["authorization", "consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
      ];
      const effectRows: MatrixEntry[] =
        operation === "keep"
          ? [
              ["review", "not-consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
              ["review", "consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
              ["review", "consumed", ["completed", "unknown"], ["not-called"], ["not-entered"], ["changed"]],
              ["review", "consumed", ["unknown"], ["not-called"], ["not-entered"], ["unknown"]],
            ]
          : [
              ["prepared", "consumed", unfinished, ["not-called"], ["not-entered"], ["unchanged"]],
              ["prepared", "consumed", ["unknown"], ["not-called"], ["io-possible", "barrier-observed"], ["unchanged"]],
              [
                "expected-after",
                "consumed",
                ["unknown"],
                ["not-called"],
                ["io-possible", "barrier-observed"],
                ["unchanged"],
              ],
              [
                "data",
                "consumed",
                ["unknown"],
                ["not-called", "not-applied", "applied", "unknown"],
                ["barrier-observed"],
                ["unchanged"],
              ],
              [
                "finalize",
                "consumed",
                ["unknown"],
                ["not-applied", "applied", "unknown"],
                ["io-possible"],
                ["unchanged"],
              ],
              ["finalize", "consumed", ["rejected", "skipped"], ["not-applied"], ["io-possible"], ["unchanged"]],
              ["finalize", "consumed", ["completed", "unknown"], ["applied"], ["barrier-observed"], ["unchanged"]],
            ];
      const key = (r: MemoryCommandFactRow) => [r.stage, r.receipt, r.outcome, r.data, r.audit, r.review].join("/");
      const allowed = new Set<string>();
      for (const [stage, receipt, outcomes, dataStates, auditStates, reviewStates] of [...common, ...effectRows]) {
        for (const outcome of outcomes)
          for (const data of dataStates)
            for (const audit of auditStates)
              for (const review of reviewStates) {
                allowed.add(key({ step: 1, operation, stage, receipt, outcome, data, audit, review }));
              }
      }
      expect(allowed.size).toBe(operation === "keep" ? 21 : 30);
      let accepted = 0;
      let denied = 0;
      for (const stage of [
        "admission",
        "plan",
        "authorization",
        "prepared",
        "expected-after",
        "data",
        "finalize",
        "review",
      ] as const) {
        for (const outcome of ["completed", "rejected", "skipped", "unknown"] as const) {
          for (const receipt of ["not-consumed", "consumed"] as const) {
            for (const data of ["not-called", "not-applied", "applied", "unknown"] as const) {
              for (const audit of ["not-entered", "io-possible", "barrier-observed"] as const) {
                for (const review of ["unchanged", "changed", "unknown"] as const) {
                  const r: MemoryCommandFactRow = { step: 1, operation, stage, outcome, receipt, data, audit, review };
                  const value = makeFacts([r]);
                  if (allowed.has(key(r))) {
                    expect(parseMemoryCommandFacts(encoded(value), CMD)).toEqual({
                      kind: "facts",
                      summary,
                      facts: value,
                    });
                    accepted++;
                  } else {
                    expect(encodeMemoryCommandFacts(summary, value), key(r)).toBeUndefined();
                    expectInvalid(canonical(value)); // hostile producer need not use our encoder
                    expect(
                      memoryCommandFactsFailure(appendix(canonical(value)), CMD, "permission", "none")?.effect,
                    ).toBe("unknown");
                    denied++;
                  }
                }
              }
            }
          }
        }
      }
      expect(accepted).toBe(allowed.size);
      expect(accepted + denied).toBe(2304);
    },
  );

  it.each(["", "Old failure\n\ntext", "旧版拒绝：无授权。", "x".repeat(25000)])(
    "keeps no-marker legacy failure verbatim: %s",
    (text) => {
      expect(parseMemoryCommandFacts(text, CMD)).toEqual({ kind: "legacy", summary: text });
      expect(memoryCommandFactsFailure(text, CMD, "permission", "none")).toEqual({
        ok: false,
        code: "E_COMMAND_DENIED",
        message: text,
        retryable: false,
        effect: "none",
      });
      expect(memoryCommandFactsFailure(text, CMD, "permission")?.effect).toBe("unknown");
    },
  );

  it("binds the exact current ledger key, without trimming, case folding or target-ID fallback", () => {
    const message = encoded();
    for (const other of ["", `${CMD} `, CMD.toUpperCase(), "rules.001", "a".repeat(64)]) {
      expect(parseMemoryCommandFacts(message, other)).toEqual(invalid);
    }
    for (const cmdId of ["命".repeat(85) + "a", "😀".repeat(64), "x ", "é", "e\u0301"]) {
      const value = { ...makeFacts(), cmdId };
      const message = encoded(value);
      expect(parseMemoryCommandFacts(message, cmdId)).toEqual({ kind: "facts", summary, facts: value });
      expect(parseMemoryCommandFacts(message, `${cmdId}x`)).toEqual(invalid);
    }
  });

  it("does not execute getters/toJSON, accept custom prototypes, or silently discard extra fields", () => {
    let called = 0;
    const getter = {
      ...makeFacts(),
      get cmdId() {
        called++;
        return CMD;
      },
    };
    const toJSON = {
      ...makeFacts(),
      toJSON() {
        called++;
        return makeFacts();
      },
    };
    const array = [completed];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get() {
        called++;
        return completed;
      },
    });
    for (const value of [
      getter,
      toJSON,
      { ...makeFacts(), rows: array },
      Object.assign(Object.create({}), makeFacts()),
      { ...makeFacts(), [Symbol("x")]: true },
    ]) {
      expect(encodeMemoryCommandFacts(summary, value)).toBeUndefined();
    }
    const badRow = {
      ...rejected,
      get code() {
        called++;
        return "permission" as const;
      },
    };
    expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), rows: [completed, badRow] })).toBeUndefined();
    expect(called).toBe(0);
    expect(
      encodeMemoryCommandFacts(
        summary,
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBeUndefined();
  });

  it("never mutates/freezes caller input and returns independent parsed rows", () => {
    const value = makeFacts();
    const before = JSON.stringify(value);
    const parsed = parseMemoryCommandFacts(encoded(value), CMD);
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.isFrozen(value)).toBe(false);
    if (parsed.kind !== "facts") throw new Error("expected facts");
    expect(parsed.facts).not.toBe(value);
    expect(parsed.facts.rows[0]).not.toBe(completed);
  });
});

describe("strict marker and canonical rejection (no selective salvage)", () => {
  it("requires one complete appendix at the end, with exact delimiters and no trailing bytes", () => {
    const message = encoded();
    const malformed = [
      `${message}\n`,
      `${message} `,
      `${message}\0`,
      `${message}suffix`,
      message.slice(0, -1),
      message.replace(":v1]", ":v2]"),
      message.replace(":v1]", ":v01]"),
      message.replace(MEMORY_RESULT_CLOSE, ""),
      message.replace(`${MEMORY_RESULT_OPEN}\n`, `${MEMORY_RESULT_OPEN}\r\n`),
      message.replace(`\n${MEMORY_RESULT_CLOSE}`, `\r\n${MEMORY_RESULT_CLOSE}`),
      `${message}\n\n${message}`,
      `${MEMORY_RESULT_OPEN}\n${message}`,
      `${MEMORY_RESULT_CLOSE}\n${message}`,
      "[pi-memory-result",
      "[pi-memory-result:v1]",
      "[/pi-memory-result",
      "[/pi-memory-result]",
      message.replace(`\n\n${MEMORY_RESULT_OPEN}`, `\n${MEMORY_RESULT_OPEN}`),
      message.replace(`${MEMORY_RESULT_OPEN}\n`, `${MEMORY_RESULT_OPEN}\n\n`),
    ];
    for (const text of malformed) expect(parseMemoryCommandFacts(text, CMD), text).toEqual(invalid);
    for (const text of [MEMORY_RESULT_OPEN, MEMORY_RESULT_CLOSE, "[pi-memory-result:v2]"]) {
      expect(encodeMemoryCommandFacts(text, makeFacts())).toBeUndefined();
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), cmdId: text })).toBeUndefined();
      expect(encodeMemoryCommandFacts(summary, makeFacts([{ ...completed, targetId: text }]))).toBeUndefined();
    }
  });

  it("rejects duplicate top-level and nested keys, whitespace, alternate escaping/order/numbers", () => {
    const json = canonical(makeFacts());
    const mutations = [
      json.replace('"v":1', '"v":1,"v":1'),
      json.replace('"effect":"partial"', '"effect":"none","effect":"partial"'),
      json.replace('"step":1', '"step":1,"step":1'),
      json.replace('"data":"applied"', '"data":"unknown","data":"applied"'),
      ` ${json}`,
      `${json} `,
      `${json}\n`,
      json.replace('"v":1', '"v":1.0'),
      json.replace('"v":1', '"v":1e0'),
      json.replace('"omitted":0', '"omitted":-0'),
      json.replace('"memory-flow"', '"memory\\u002dflow"'),
      JSON.stringify(makeFacts()), // insertion order differs from sorted-key canonical
      json.replace('"cmdId":', '\n"cmdId":'),
    ];
    for (const mutation of mutations) expectInvalid(mutation);
  });

  it("rejects unknown/missing fields, versions, kinds, enum values, raw reasons and hidden metadata", () => {
    const base = makeFacts();
    const values: unknown[] = [null, [], {}, { ...base, v: 2 }, { ...base, kind: "other" }, { ...base, raw: "body" }];
    for (const key of Object.keys(base)) {
      const missing: Record<string, unknown> = { ...base };
      delete missing[key];
      values.push(missing);
    }
    for (const key of Object.keys(completed).filter((key) => key !== "actionId" && key !== "targetId")) {
      const missing: Record<string, unknown> = { ...completed };
      delete missing[key];
      values.push({ ...base, rows: [missing, rejected] });
    }
    for (const key of ["operation", "outcome", "receipt", "stage", "data", "audit", "review", "code"]) {
      values.push({ ...base, rows: [{ ...completed, [key]: "arbitrary-provider-reason" }, rejected] });
    }
    for (const key of ["body", "path", "credential", "reason", "provider", "authorization", "__proto__"]) {
      values.push({ ...base, rows: [{ ...completed, [key]: "private" }, rejected] });
    }
    for (const value of values) {
      expect(encodeMemoryCommandFacts(summary, value)).toBeUndefined();
      expectInvalid(canonical(value));
    }
    // One valid success row is NEVER salvaged from a message containing a bad later row.
    expect(
      parseMemoryCommandFacts(
        appendix(canonical({ ...base, rows: [completed, { ...rejected, code: "secret" }] })),
        CMD,
      ),
    ).toEqual(invalid);
  });

  it("rejects malformed and duplicate/out-of-order steps, sparse arrays and non-integer counts", () => {
    for (const step of [0, -1, 17, 1.5, "1", null])
      expectInvalid(canonical({ ...makeFacts(), rows: [{ ...completed, step }] }));
    for (const rows of [
      [completed, completed],
      [rejected, completed],
      new Array(1),
      Object.assign([completed], { extra: true }),
    ]) {
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), rows })).toBeUndefined();
    }
    for (const omitted of [-1, 0.5, "0", undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), omitted })).toBeUndefined();
    }
    for (const omitted of [0, 1, null, Number.MAX_SAFE_INTEGER]) {
      const value = makeFacts([completed], omitted);
      expect(parseMemoryCommandFacts(encoded(value), CMD)).toEqual({ kind: "facts", summary, facts: value });
    }
    const gaps = makeFacts([
      { ...completed, step: 2 },
      { ...rejected, step: 16 },
    ]);
    expect(parseMemoryCommandFacts(encoded(gaps), CMD)).toEqual({ kind: "facts", summary, facts: gaps });
  });
});

describe("UTF-8 and full approved resource budgets", () => {
  it("pins ALL approved numbers, including enclosing budgets (no shrinking)", () => {
    expect(MEMORY_FACTS_LIMITS).toEqual({
      summaryBytes: 4096,
      jsonBytes: 16384,
      messageBytes: 24576,
      rowBytes: 768,
      rows: 16,
      cmdIdBytes: 256,
      targetIdBytes: 128,
      codeBytes: 48,
    });
  });

  it.each(["a".repeat(4096), "中".repeat(1365) + "x", "😀".repeat(1024)])(
    "accepts 4096 UTF-8 summary bytes and rejects +1 without truncation",
    (text) => {
      expect(Buffer.byteLength(text)).toBe(4096);
      expect(parseMemoryCommandFacts(encoded(makeFacts(), text), CMD)).toEqual({
        kind: "facts",
        summary: text,
        facts: makeFacts(),
      });
      expect(encodeMemoryCommandFacts(`${text}x`, makeFacts())).toBeUndefined();
      expect(parseMemoryCommandFacts(appendix(canonical(makeFacts()), `${text}x`), CMD)).toEqual(invalid);
    },
  );

  it("accepts full 256B command/128B target IDs, rejects +1 and all controls/unpaired surrogates", () => {
    for (const cmdId of ["x".repeat(256), "中".repeat(85) + "x", "😀".repeat(64)]) {
      for (const targetId of ["x".repeat(128), "中".repeat(42) + "xx", "😀".repeat(32), '"'.repeat(128)]) {
        const value = { ...makeFacts([{ ...completed, targetId }]), cmdId };
        expect(parseMemoryCommandFacts(encoded(value), cmdId)).toEqual({ kind: "facts", summary, facts: value });
        expect(
          encodeMemoryCommandFacts(summary, { ...value, rows: [{ ...completed, targetId: `${targetId}x` }] }),
        ).toBeUndefined();
      }
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), cmdId: `${cmdId}x` })).toBeUndefined();
    }
    for (const bad of ["", "a\0", "a\n", "a\r", "a\t", "a\x7f", "a\x85", "a\ud800", "a\udc00"]) {
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), cmdId: bad })).toBeUndefined();
      expect(encodeMemoryCommandFacts(summary, makeFacts([{ ...completed, targetId: bad }]))).toBeUndefined();
    }
    expect(encodeMemoryCommandFacts("\ud800", makeFacts())).toBeUndefined();
    expectInvalid(canonical({ ...makeFacts(), cmdId: "\ud800" }));
  });

  it("handles Unicode normalization, escaping and Unicode line separators deterministically", () => {
    for (const targetId of ["é", "e\u0301", 'a"b\\c', "x\u2028y\u2029z", "🧠"]) {
      const value = makeFacts([{ ...completed, targetId }]);
      const message = encoded(value);
      expect(parseMemoryCommandFacts(message, CMD)).toEqual({ kind: "facts", summary, facts: value });
      const json = message.split(`\n${MEMORY_RESULT_OPEN}\n`)[1]!.split(`\n${MEMORY_RESULT_CLOSE}`)[0]!;
      expect(json).not.toMatch(/[\r\n\u2028\u2029]/);
      if (targetId.includes("\u2028")) expectInvalid(json.replace("\\u2028", "\u2028"));
    }
  });

  it("requires exactly 64 lowercase hex for action IDs", () => {
    for (const actionId of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 12, null]) {
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), rows: [{ ...completed, actionId }] })).toBeUndefined();
    }
    for (const actionId of ["0".repeat(64), "abcdef0123456789".repeat(4)]) {
      expect(parseMemoryCommandFacts(encoded(makeFacts([{ ...completed, actionId }])), CMD).kind).toBe("facts");
    }
  });

  it("keeps all 16 worst-width legal rows at once plus a full summary/command ID", () => {
    const rows = Array.from({ length: 16 }, (_, index): MemoryCommandFactRow => ({
      ...rejected,
      actionId: "a".repeat(64),
      step: index + 1,
      targetId: '"'.repeat(128),
      code: "E_MEM_CONFIRM_UNAVAILABLE",
    }));
    const value = { ...makeFacts(rows), cmdId: '"'.repeat(256) };
    const text = "😀".repeat(1024);
    const message = encoded(value, text);
    expect(parseMemoryCommandFacts(message, value.cmdId)).toEqual({ kind: "facts", summary: text, facts: value });
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(24576);
    expect(Buffer.byteLength(canonical(value))).toBeLessThanOrEqual(16384);
    for (const r of rows) expect(Buffer.byteLength(canonical(r))).toBeLessThanOrEqual(768);
    expect(encodeMemoryCommandFacts(text, { ...value, rows: [...rows, { ...completed, step: 17 }] })).toBeUndefined();
    // Inner closed-field budgets imply tighter reachable maxima. Exercise outer reject paths
    // with oversized untrusted JSON/messages rather than inventing extra fields to fill them.
    expectInvalid(" ".repeat(16385));
    expect(parseMemoryCommandFacts(appendix(canonical(makeFacts()), "x".repeat(24577)), CMD)).toEqual(invalid);
  });
});

describe("aggregate recomputation and conservative failure mapping", () => {
  it("distinguishes completed, definite refusal/skip partial, none and unknown", () => {
    const skipped: MemoryCommandFactRow = { ...rejected, outcome: "skipped" };
    const kept: MemoryCommandFactRow = {
      ...completed,
      operation: "keep",
      stage: "review",
      data: "not-called",
      audit: "not-entered",
      review: "changed",
    };
    const cases: [readonly MemoryCommandFactRow[], number | null, MemoryCommandFacts["effect"]][] = [
      [[], 0, "none"],
      [[rejected], 0, "none"],
      [[skipped], 0, "none"],
      [[completed], 0, "completed"],
      [[kept], 0, "completed"],
      [[completed, rejected], 0, "partial"],
      [[completed, skipped], 0, "partial"],
      [[completed], 1, "unknown"],
      [[rejected], null, "unknown"],
      [[], null, "unknown"],
      [[{ ...rejected, receipt: "consumed" }], 0, "none"],
      [
        [{ ...rejected, receipt: "consumed", stage: "finalize", data: "not-applied", audit: "io-possible" }],
        0,
        "unknown",
      ],
    ];
    for (const [rows, omitted, effect] of cases) {
      expect(aggregateMemoryCommandEffect(rows, omitted)).toBe(effect);
      const value = makeFacts(rows, omitted);
      expect(value.effect).toBe(effect);
      expect(parseMemoryCommandFacts(encoded(value), CMD)).toEqual({ kind: "facts", summary, facts: value });
      for (const conflict of ["none", "completed", "partial", "unknown"].filter((candidate) => candidate !== effect)) {
        expect(encodeMemoryCommandFacts(summary, { ...value, effect: conflict })).toBeUndefined();
        expectInvalid(canonical({ ...value, effect: conflict }));
      }
    }
  });

  it("honest uncertain observations dominate prior completion, without changing their row facts", () => {
    const uncertain: MemoryCommandFactRow[] = [
      { ...rejected, outcome: "unknown" },
      { ...rejected, outcome: "unknown", receipt: "consumed" },
      { ...rejected, outcome: "unknown", receipt: "consumed", stage: "prepared", audit: "io-possible" },
      { ...completed, step: 2, outcome: "unknown", stage: "data", data: "unknown" },
      { ...completed, step: 2, outcome: "unknown", audit: "io-possible", code: "finalization-failure" },
      { ...rejected, outcome: "unknown", code: "E_MEM_EFFECT_UNKNOWN" },
      { ...completed, step: 2, outcome: "unknown", code: "finalization-failure" },
      { ...rejected, outcome: "unknown", operation: "keep", receipt: "consumed", stage: "review", review: "unknown" },
      { ...rejected, outcome: "unknown", operation: "keep", receipt: "consumed", stage: "review", review: "changed" },
    ];
    for (const r of uncertain) {
      expect(aggregateMemoryCommandEffect([r], 0)).toBe("unknown");
      expect(aggregateMemoryCommandEffect([completed, r], 0)).toBe("unknown");
      const value = makeFacts([completed, r]);
      expect(parseMemoryCommandFacts(encoded(value), CMD)).toEqual({ kind: "facts", summary, facts: value });
      expect(memoryCommandFactsFailure(encoded(value), CMD, r.code, "none")?.effect).toBe("unknown");
    }
  });

  it.each([
    ["completed with unknown data", { ...completed, data: "unknown" }],
    ["completed without consumed receipt", { ...completed, receipt: "not-consumed" }],
    [
      "pre-consume refusal with an observed barrier",
      { ...completed, outcome: "rejected", receipt: "not-consumed", stage: "admission", data: "not-called" },
    ],
    ["completion with failure code", { ...completed, code: "E_MEM_CONFIRM_DECLINED" }],
    ["refusal with applied data", { ...completed, outcome: "rejected" }],
    ["keep completion on the E data path", { ...completed, operation: "keep" }],
  ] as const)("rejects the WHOLE message for %s, including after a real prior success", (_name, conflict) => {
    expect(aggregateMemoryCommandEffect([conflict], 0)).toBe("unknown");
    for (const rows of [[conflict], [completed, { ...conflict, step: 2 }]]) {
      // Even matching an unknown aggregate, omitted rows, or a forged none/partial cannot
      // rescue the row, and the caller's explicit legacy none must not mask the conflict.
      for (const omitted of [0, 1, null])
        for (const effect of ["none", "completed", "partial", "unknown"]) {
          const value = { ...makeFacts(rows), omitted, effect };
          expect(encodeMemoryCommandFacts(summary, value)).toBeUndefined();
          const message = appendix(canonical(value));
          expect(parseMemoryCommandFacts(message, CMD)).toEqual(invalid);
          expect(memoryCommandFactsFailure(message, CMD, "permission", "none")).toMatchObject({
            ok: false,
            effect: "unknown",
            retryable: false,
          });
        }
    }
  });

  it("does not mistake a prepared/expected-after fsync failure for not-applied", () => {
    for (const stage of ["prepared", "expected-after"] as const) {
      const value = makeFacts([
        { ...rejected, receipt: "consumed", stage, outcome: "unknown", data: "not-called", audit: "io-possible" },
      ]);
      const parsed = parseMemoryCommandFacts(encoded(value), CMD);
      expect(parsed).toEqual({ kind: "facts", summary, facts: value });
      expect(value.effect).toBe("unknown");
      expect(value.rows[0]!.data).toBe("not-called");
    }
    const applied = makeFacts([{ ...completed, outcome: "unknown", code: "finalization-failure" }]);
    expect(parseMemoryCommandFacts(encoded(applied), CMD)).toEqual({ kind: "facts", summary, facts: applied });
    expect(applied.effect).toBe("unknown");
    expect(applied.rows[0]!.data).toBe("applied");
  });

  it("accepts only the explicitly reviewed existing domain code set", () => {
    const expected = {
      E_MEM_CONFIRM_DECLINED: "E_COMMAND_DENIED",
      E_MEM_CONFIRM_TIMEOUT: "E_DEADLINE",
      E_MEM_CONFIRM_UNAVAILABLE: "E_COMMAND_DENIED",
      E_MEM_CONFIRM_STALE: "E_STALE_CTX",
      E_MEM_NEEDS_HUMAN_COMMAND: "E_COMMAND_DENIED",
      E_MEM_PLAN_CHANGED: "E_COMMAND_DENIED",
      E_MEM_BUSY: "E_RATE",
      E_MEM_EFFECT_UNKNOWN: "E_COMMAND_DENIED",
      E_MEM_PLAN_BUDGET: "E_DEADLINE",
      stale: "E_STALE_CTX",
      permission: "E_COMMAND_DENIED",
      gate: "E_COMMAND_DENIED",
      digest: "E_COMMAND_DENIED",
      unavailable: "E_COMMAND_DENIED",
      "post-apply-failure": "E_COMMAND_DENIED",
      "observation-mismatch": "E_COMMAND_DENIED",
      "finalization-failure": "E_COMMAND_DENIED",
    } as const;
    for (const [code, wireCode] of Object.entries(expected)) {
      expect(memoryCommandFailureCode(code)).toBe(wireCode);
      expect(code).toMatch(/^[\x20-\x7e]{1,48}$/);
      const uncertainCode = [
        "E_MEM_EFFECT_UNKNOWN",
        "post-apply-failure",
        "observation-mismatch",
        "finalization-failure",
      ].includes(code);
      const value = makeFacts([
        uncertainCode
          ? { ...completed, outcome: "unknown", audit: "io-possible", code: code as keyof typeof expected }
          : { ...rejected, code: code as keyof typeof expected },
      ]);
      expect(parseMemoryCommandFacts(encoded(value), CMD)).toEqual({ kind: "facts", summary, facts: value });
      expect(memoryCommandFactsFailure(encoded(value), CMD, code)).toMatchObject({
        ok: false,
        code: wireCode,
        retryable: false,
        effect: ["E_MEM_EFFECT_UNKNOWN", "post-apply-failure", "observation-mismatch", "finalization-failure"].includes(
          code,
        )
          ? "unknown"
          : "none",
      });
    }
    for (const code of [
      "arbitrary",
      "x".repeat(49),
      "E_MEM_NEW_PROVIDER_REASON",
      "__proto__",
      "toString",
      "constructor",
      "permission\nsecret",
      "权限",
      {},
      null,
    ]) {
      expect(memoryCommandFailureCode(code)).toBeUndefined();
      expect(encodeMemoryCommandFacts(summary, { ...makeFacts(), rows: [{ ...rejected, code }] })).toBeUndefined();
    }
  });

  it("maps partial/unknown to nonretryable unknown; pre-consume rejection to none; completed is not failure", () => {
    const message = encoded();
    expect(memoryCommandFactsFailure(message, CMD, "E_MEM_BUSY")).toEqual({
      ok: false,
      code: "E_RATE",
      message,
      retryable: false,
      effect: "unknown",
    });
    const refusal = encoded(makeFacts([rejected]));
    expect(memoryCommandFactsFailure(refusal, CMD, "E_MEM_CONFIRM_STALE")).toEqual({
      ok: false,
      code: "E_STALE_CTX",
      message: refusal,
      retryable: false,
      effect: "none",
    });
    expect(memoryCommandFactsFailure(encoded(makeFacts([completed])), CMD, "permission")).toBeUndefined();
    for (const bad of [
      message.slice(0, -1),
      message.replace(CMD, "not_this_cmd"),
      message.replace('"effect":"partial"', '"effect":"none"'),
    ]) {
      expect(memoryCommandFactsFailure(bad, CMD, "unreviewed-code", "none")).toEqual({
        ok: false,
        code: "E_COMMAND_DENIED",
        message: bad,
        retryable: false,
        effect: "unknown",
      });
    }
  });
});

describe("old schema compatibility and browser boundary (not production three-channel integration)", () => {
  it("roundtrips the SAME partial sample through current unchanged direct/late/query schemas", () => {
    const message = encoded();
    const failure = memoryCommandFactsFailure(message, CMD, "E_MEM_CONFIRM_DECLINED")!;
    const frames = [
      { t: "cmd_result", rid: "r1", id: CMD, ...failure },
      { t: "cmd_late", id: CMD, op: "command", at: 1, ...failure },
      {
        t: "cmd_result",
        rid: "q1",
        id: CMD,
        ok: true,
        data: { op: "query", state: "failed", late: true, result: failure },
      },
    ];
    for (const frame of frames) expect(decodeAgentFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
    const factsByFrame = frames.map((frame) => {
      const raw = JSON.parse(JSON.stringify(frame)) as { message?: string; data?: { result: { message: string } } };
      return parseMemoryCommandFacts(raw.message ?? raw.data!.result.message, CMD);
    });
    expect(factsByFrame).toEqual(Array.from({ length: 3 }, () => ({ kind: "facts", summary, facts: makeFacts() })));
    expect(
      decodeHubFrame({
        t: "cmd",
        rid: "q1",
        id: CMD,
        deadlineMs: 1000,
        queryOnly: true,
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
        cmd: { op: "command", name: "mem", args: "review" },
      }),
    ).toBeDefined();
    for (const frame of frames.slice(0, 2)) {
      expect(decodeAgentFrame({ ...frame, data: { memoryFlow: makeFacts() } })).toBeUndefined();
    }
    // This is schema-level compatibility only: no real commands/ledger/network/DOM here.
  });

  it("runs the actual module without imports or Node globals, in an isolated ECMAScript realm", () => {
    const source = readFileSync(
      new URL("../../../src/web-hub/protocol/memory-command-facts.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bimport\s*(?:\(|["'{*]|type\b)/);
    const js = stripTypeScriptTypes(source).replace(/^export /gm, "");
    const result: unknown = runInNewContext(
      `${js}\nJSON.stringify((() => {
      if (typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof require !== 'undefined') throw new Error('Node globals leaked');
      const value = JSON.parse(${JSON.stringify(JSON.stringify(makeFacts()))});
      const text = encodeMemoryCommandFacts(${JSON.stringify(summary)}, value);
      return { text, parsed: parseMemoryCommandFacts(text, ${JSON.stringify(CMD)}) };
    })())`,
      {},
      { timeout: 1000 },
    );
    expect(JSON.parse(result as string)).toEqual({
      text: encoded(),
      parsed: { kind: "facts", summary, facts: makeFacts() },
    });
    const testSource = readFileSync(new URL("./memory-command-facts.test.ts", import.meta.url), "utf8");
    expect(scanTier1Markers(testSource)).toEqual([]);
  });
});
