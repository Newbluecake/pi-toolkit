import { describe, expect, it } from "vitest";
import { POINTED, type SectionState } from "../../src/prompt-sections/stable-section.js";
import {
  PROMPT_SECTIONS_ENTRY_TYPE,
  readBackSectionStates,
  sanitizePromptSectionsEntry,
  serializeSectionStates,
} from "../../src/prompt-sections/store.js";

const names = ["pi_project_memory", "pi_subagent_types", "pi_subagent_models"] as const;
const state: SectionState = { snapshot: "snap", announced: POINTED, stale: true, sentCount: 3, sentBytes: 99 };

describe("prompt section store", () => {
  it("round-trips state and encodes pointed/stale compactly", () => {
    const encoded = serializeSectionStates(new Map([[names[0], state]]));
    expect(encoded).toEqual({
      v: 1,
      sections: { pi_project_memory: { snapshot: "snap", pointer: true, stale: true, sentCount: 3, sentBytes: 99 } },
    });
    const restored = readBackSectionStates(
      [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: encoded }],
      "resume",
      names,
    );
    expect(restored?.states.get(names[0])).toEqual(state);
    expect(restored?.states.get(names[1])?.snapshot).toBeUndefined();
    expect(restored?.exact).toBe(false);
  });
  it("ignores unknown sections and bad sections while preserving valid ones", () => {
    const clean = sanitizePromptSectionsEntry({
      v: 1,
      sections: {
        pi_project_memory: { snapshot: "ok", sentCount: 0, sentBytes: 0 },
        pi_subagent_types: { snapshot: 2, sentCount: 0, sentBytes: 0 },
        foreign: { snapshot: "ignored", sentCount: 0, sentBytes: 0 },
      },
    });
    expect(clean).toEqual({ v: 1, sections: { pi_project_memory: { snapshot: "ok", sentCount: 0, sentBytes: 0 } } });
    expect(sanitizePromptSectionsEntry({ v: 2, sections: {} })).toBeUndefined();
    expect(readBackSectionStates([], "startup", names)).toBeUndefined();
    expect(readBackSectionStates([], "new", names)).toBeUndefined();
  });
  it("marks reload after compaction as non-exact", () => {
    const data = serializeSectionStates(
      new Map([[names[0], { snapshot: "x", announced: "x", stale: false, sentCount: 0, sentBytes: 0 }]]),
    );
    const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }, { type: "compaction" }];
    expect(readBackSectionStates(branch, "reload", names)?.exact).toBe(false);
  });

  describe("sanitizePromptSectionsEntry: field-level corruption tolerance (never throws, drop-and-keep)", () => {
    const validSection = { snapshot: "ok", sentCount: 0, sentBytes: 0 };

    it.each([
      ["missing snapshot", { sentCount: 0, sentBytes: 0 }],
      ["snapshot: number", { snapshot: 42, sentCount: 0, sentBytes: 0 }],
      ["snapshot: null", { snapshot: null, sentCount: 0, sentBytes: 0 }],
      ["snapshot: array", { snapshot: ["x"], sentCount: 0, sentBytes: 0 }],
      ["missing sentCount", { snapshot: "ok", sentBytes: 0 }],
      ["sentCount: fractional", { snapshot: "ok", sentCount: 1.5, sentBytes: 0 }],
      ["sentCount: negative", { snapshot: "ok", sentCount: -1, sentBytes: 0 }],
      ["sentCount: NaN", { snapshot: "ok", sentCount: Number.NaN, sentBytes: 0 }],
      ["sentCount: Infinity", { snapshot: "ok", sentCount: Number.POSITIVE_INFINITY, sentBytes: 0 }],
      ["sentCount: string", { snapshot: "ok", sentCount: "3", sentBytes: 0 }],
      ["missing sentBytes", { snapshot: "ok", sentCount: 0 }],
      ["sentBytes: fractional", { snapshot: "ok", sentCount: 0, sentBytes: 0.1 }],
      ["sentBytes: negative", { snapshot: "ok", sentCount: 0, sentBytes: -5 }],
      ["announced: number", { snapshot: "ok", sentCount: 0, sentBytes: 0, announced: 1 }],
      ["announced: object", { snapshot: "ok", sentCount: 0, sentBytes: 0, announced: {} }],
      ["pointer: false", { snapshot: "ok", sentCount: 0, sentBytes: 0, pointer: false }],
      ["pointer: 1", { snapshot: "ok", sentCount: 0, sentBytes: 0, pointer: 1 }],
      ["pointer: 'true' (string)", { snapshot: "ok", sentCount: 0, sentBytes: 0, pointer: "true" }],
      ["stale: false", { snapshot: "ok", sentCount: 0, sentBytes: 0, stale: false }],
      ["stale: 1", { snapshot: "ok", sentCount: 0, sentBytes: 0, stale: 1 }],
      [
        "pointer:true conflicting with announced",
        { snapshot: "ok", sentCount: 0, sentBytes: 0, pointer: true, announced: "x" },
      ],
      ["section value: string, not a record", "not-a-record"],
      ["section value: array", ["nope"]],
      ["section value: null", null],
    ])("drops an invalid section (%s) while keeping its valid siblings", (_label, badSection) => {
      const clean = sanitizePromptSectionsEntry({
        v: 1,
        sections: { pi_project_memory: validSection, pi_subagent_types: badSection },
      });
      expect(clean).toEqual({ v: 1, sections: { pi_project_memory: validSection } });
    });

    it.each([
      ["raw not an object", "a string"],
      ["raw is null", null],
      ["raw is an array", [1, 2, 3]],
      ["v is a string", { v: "1", sections: {} }],
      ["v is 2", { v: 2, sections: {} }],
      ["sections missing", { v: 1 }],
      ["sections is an array", { v: 1, sections: [] }],
      ["sections is a string", { v: 1, sections: "nope" }],
    ])("rejects the whole entry (%s)", (_label, raw) => {
      expect(sanitizePromptSectionsEntry(raw)).toBeUndefined();
    });

    it("ignores an unknown section name alongside a corrupt known one, keeping neither", () => {
      const clean = sanitizePromptSectionsEntry({
        v: 1,
        sections: {
          pi_subagent_models: { snapshot: 5, sentCount: 0, sentBytes: 0 }, // corrupt
          totally_unknown_section: validSection, // unregistered name
        },
      });
      expect(clean).toEqual({ v: 1, sections: {} });
    });

    it("a section with only the required fields round-trips with announced defaulting to snapshot", () => {
      const clean = sanitizePromptSectionsEntry({ v: 1, sections: { pi_project_memory: validSection } });
      expect(clean).toEqual({ v: 1, sections: { pi_project_memory: validSection } });
    });
  });

  describe("readBackSectionStates: reason / branch-walk edge cases", () => {
    it('reason "new" never inherits, even from a branch with a perfectly valid entry', () => {
      const data = serializeSectionStates(
        new Map([[names[0], { snapshot: "x", announced: "x", stale: false, sentCount: 0, sentBytes: 0 }]]),
      );
      const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }];
      expect(readBackSectionStates(branch, "new", names)).toBeUndefined();
    });

    it("ignores entries with the right type but wrong customType, and vice versa", () => {
      const data = serializeSectionStates(new Map([[names[0], { ...state, announced: state.snapshot }]]));
      const branch = [
        { type: "custom", customType: "subagent:something-else", data },
        { type: "compaction", customType: PROMPT_SECTIONS_ENTRY_TYPE, data },
      ];
      expect(readBackSectionStates(branch, "resume", names)).toBeUndefined();
    });

    it("walks backward and uses the LAST matching entry when several are present", () => {
      const older = serializeSectionStates(new Map([[names[0], { ...state, snapshot: "older" }]]));
      const newer = serializeSectionStates(new Map([[names[0], { ...state, snapshot: "newer" }]]));
      const branch = [
        { type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: older },
        { type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: newer },
      ];
      const restored = readBackSectionStates(branch, "resume", names);
      expect(restored?.states.get(names[0])?.snapshot).toBe("newer");
    });

    it("an entry that fails sanitization is skipped in favor of an earlier valid one", () => {
      const valid = serializeSectionStates(new Map([[names[0], { ...state, snapshot: "valid" }]]));
      const branch = [
        { type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: valid },
        { type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: { v: 2, sections: {} } }, // corrupt (wrong v)
      ];
      const restored = readBackSectionStates(branch, "resume", names);
      expect(restored?.states.get(names[0])?.snapshot).toBe("valid");
    });

    it("only surfaces `registered` sections even when the entry carries more", () => {
      const data = serializeSectionStates(
        new Map([
          [names[0], { ...state, snapshot: "mem" }],
          [names[1], { ...state, snapshot: "types" }],
        ]),
      );
      const branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data }];
      const restored = readBackSectionStates(branch, "resume", [names[0]]);
      expect(restored?.states.has(names[1])).toBe(false);
      expect(restored?.states.get(names[0])?.snapshot).toBe("mem");
    });
  });
});
