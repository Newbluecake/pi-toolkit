import { describe, expect, it } from "vitest";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  createMentionAutocompleteProvider,
  type MentionAutocompleteEntry,
  type MentionSessionAutocompleteEntry,
} from "../../src/mention/autocomplete.js";

/**
 * fabric reply-plan §9.5 (package M): session completions — entries after the agent group,
 * `session · <cwdLabel> · <receive> · <busy|idle>` descriptions, and the insert-value rule
 * (bare `@name` only when §9.1 ①②③ + cache-unique approve; every conflict forces the explicit
 * `@session:<ref>`). Base provider is a stub — the real CombinedAutocompleteProvider matrix
 * (file passthrough etc.) stays in autocomplete.test.ts, which must remain byte-identical.
 */

const options = () => ({ signal: new AbortController().signal, force: true });

function fakeBase(items: AutocompleteItem[]): AutocompleteProvider {
  return {
    async getSuggestions() {
      return items.length > 0 ? { prefix: "", items } : null;
    },
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: (lines[0] ?? "").length }),
  };
}

const WORKER: MentionAutocompleteEntry = { label: "worker", type: "general", runId: "r1", status: "running" };
const FILE_ITEM: AutocompleteItem = { value: "@src/index.ts", label: "@src/index.ts", description: "file" };

function session(
  ref: string,
  name: string | undefined,
  extra: Partial<MentionSessionAutocompleteEntry> = {},
): MentionSessionAutocompleteEntry {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/pi",
    receive: "wake",
    busy: false,
    ...extra,
  };
}

describe("§9.5 session completions", () => {
  it("session items come AFTER the agent group and BEFORE base file items", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([FILE_ITEM]), {
      entries: () => [WORKER],
      sessions: () => [session("ab12cd34", "builder")],
      sessionBareName: () => true,
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items.map((i) => i.value)).toEqual(["@worker", "@builder", "@src/index.ts"]);
    expect(result?.prefix).toBe("@");
  });

  it("description format: session · <cwdLabel> · <receive> · <busy|idle>", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [
        session("ab12cd34", "builder", { cwdLabel: "~/pi", receive: "deliver", busy: true }),
        session("ef9911aa", undefined),
      ],
      sessionBareName: () => true,
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items[0]?.description).toBe("session · ~/pi · deliver · busy");
    expect(result?.items[1]?.description).toBe("session · ~/pi · wake · idle");
  });

  it("insert value: bare @name only when sessionBareName approves; conflicts force @session:<ref>", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", "clean"), session("ef9911aa", "conflict")],
      sessionBareName: (name) => name === "clean",
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items.map((i) => i.value)).toEqual(["@clean", "@session:ef9911aa"]);
  });

  it("an unnamed entry always inserts the explicit ref", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", undefined)],
      sessionBareName: () => true, // would approve any name — there is none
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items.map((i) => i.value)).toEqual(["@session:ab12cd34"]);
  });

  it("filtering: prefix matches the bare name OR the explicit session:<ref> operand", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", "builder"), session("ef9911aa", undefined)],
      sessionBareName: () => true,
    });
    const byName = await provider.getSuggestions(["@bu"], 0, 3, options());
    expect(byName?.items.map((i) => i.value)).toEqual(["@builder"]);
    const byExplicit = await provider.getSuggestions(["@ses"], 0, 4, options());
    expect(byExplicit?.items.map((i) => i.value)).toEqual(["@session:ef9911aa"]); // "builder" doesn't start with "ses"
    const byRefPrefix = await provider.getSuggestions(["@session:ef"], 0, 10, options());
    expect(byRefPrefix?.items.map((i) => i.value)).toEqual(["@session:ef9911aa"]);
  });

  it("session items alone (no agent entries) still surface before base items", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([FILE_ITEM]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", "builder")],
      sessionBareName: () => false,
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items.map((i) => i.value)).toEqual(["@session:ab12cd34", "@src/index.ts"]);
  });

  it("applyCompletion inserts `@session:<ref> ` with the trailing space (parse-compatible)", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", undefined)],
      sessionBareName: () => false,
    });
    const result = await provider.getSuggestions(["@session:ab"], 0, 11, options());
    const item = result?.items[0];
    expect(item).toBeDefined();
    const applied = provider.applyCompletion(["@session:ab now"], 0, 11, item!, result!.prefix);
    expect(applied).toEqual({ lines: ["@session:ab12cd34 now"], cursorLine: 0, cursorCol: 18 });
  });

  it("a throwing sessions()/sessionBareName() degrades to no entries / explicit refs", async () => {
    const provider = createMentionAutocompleteProvider(fakeBase([FILE_ITEM]), {
      entries: () => [],
      sessions: () => {
        throw new Error("directory unreadable");
      },
    });
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result).toEqual({ prefix: "", items: [FILE_ITEM] }); // byte-identical to base-only

    const provider2 = createMentionAutocompleteProvider(fakeBase([]), {
      entries: () => [],
      sessions: () => [session("ab12cd34", "x")],
      sessionBareName: () => {
        throw new Error("stat boom");
      },
    });
    const result2 = await provider2.getSuggestions(["@"], 0, 1, options());
    expect(result2?.items.map((i) => i.value)).toEqual(["@session:ab12cd34"]);
  });

  it("§9.7 off states: sessions absent / [] keep the output byte-identical", async () => {
    const base = fakeBase([FILE_ITEM]);
    const bare = createMentionAutocompleteProvider(base, { entries: () => [WORKER] });
    const offProvider = createMentionAutocompleteProvider(fakeBase([FILE_ITEM]), { entries: () => [WORKER] });
    const emptySessions = createMentionAutocompleteProvider(fakeBase([FILE_ITEM]), {
      entries: () => [WORKER],
      sessions: () => [], // joined-but-empty directory
      sessionBareName: () => true,
    });
    const expected = await bare.getSuggestions(["@"], 0, 1, options());
    expect(await offProvider.getSuggestions(["@"], 0, 1, options())).toEqual(expected);
    expect(await emptySessions.getSuggestions(["@"], 0, 1, options())).toEqual(expected);
    // and the historical ":84 branch": no agent items and no session items ⇒ the BASE result object itself
    const baseOnly = fakeBase([FILE_ITEM]);
    const none = createMentionAutocompleteProvider(baseOnly, { entries: () => [] });
    const baseResult = await baseOnly.getSuggestions(["@"], 0, 1, options());
    expect(await none.getSuggestions(["@"], 0, 1, options())).toEqual(baseResult);
  });
});
