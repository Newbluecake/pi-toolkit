import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createXsDirectoryCache, type XsDirectoryRow } from "../../src/fabric/xs/directory.js";
import { createMentionAutocompleteProvider } from "../../src/mention/autocomplete.js";
import { parseSessionMention, sessionCompletionAlias } from "../../src/mention/session.js";
import { XS_LIST_MAX_ROWS } from "../../src/web-hub/protocol/xs.js";

function row(ref: string, name?: string, alias?: string): XsDirectoryRow {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/x",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 1,
    ...(alias !== undefined ? { alias } : {}),
  };
}

function setup(rows: XsDirectoryRow[], opts: { alias?: boolean; labels?: string[]; cwd?: string } = {}) {
  const cache = createXsDirectoryCache({
    source: { view: () => ({ key: "k" }), fetch: async () => undefined },
    now: () => 1,
  });
  cache.ingest(rows);
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "al5b-"));
  const deps = {
    isLabel: (n: string) => (opts.labels ?? []).includes(n),
    cwd: () => cwd,
    lookupExact: (n: string) => cache.lookupExact(n),
    ...(opts.alias === false ? {} : { aliasMode: () => true, lookupAlias: (a: string) => cache.lookupAlias(a) }),
  };
  return { cache, deps, cwd };
}

describe("directory.lookupAlias", () => {
  it("unique hit, exempt from truncation; 2 hits ⇒ undefined", () => {
    const { cache } = setup([
      row("r0", "a", "web"),
      ...Array.from({ length: XS_LIST_MAX_ROWS - 1 }, (_, i) => row(`x${i}`, `n${i}`)),
    ]);
    expect(cache.truncated()).toBe(true);
    expect(cache.lookupAlias("web")?.ref).toBe("r0");
    expect(cache.lookupAlias("nope")).toBeUndefined();
    const d = setup([row("a", undefined, "web"), row("b", undefined, "web")]);
    expect(d.cache.lookupAlias("web")).toBeUndefined();
  });
});

describe("alias-plan §5.4 @别名 (AL5b)", () => {
  it("@WEB: A.name=WEB, B.alias=web ⇒ alias wins, target is the canonical alias", () => {
    const { deps } = setup([row("A", "WEB"), row("B", "b", "web")]);
    const p = parseSessionMention("@WEB hi", deps);
    expect(p).toMatchObject({ form: "bare", target: "web", via: "alias", label: "WEB", message: "hi" });
  });

  it("full-width input normalizes (ＷＥＢ → web)", () => {
    const { deps } = setup([row("B", "b", "web")]);
    expect(parseSessionMention("@ＷＥＢ hi", deps)?.target).toBe("web");
  });

  it("CJK alias intercepts (not matched by BARE_SESSION_NAME_RE)", () => {
    const { deps } = setup([row("B", "b", "前端")]);
    expect(parseSessionMention("@前端 你好", deps)).toMatchObject({ target: "前端", via: "alias" });
  });

  it("subagent label wins", () => {
    const { deps } = setup([row("B", "b", "web")], { labels: ["web"] });
    expect(parseSessionMention("@web hi", deps)).toBeUndefined();
  });

  it("same-name file releases to pi", () => {
    const { deps, cwd } = setup([row("B", "b", "web")]);
    writeFileSync(join(cwd, "web"), "");
    expect(parseSessionMention("@web hi", deps)).toBeUndefined();
  });

  it("alias hit is exempt from the 20-row truncation rule", () => {
    const rows = [
      row("r0", "a", "web"),
      ...Array.from({ length: XS_LIST_MAX_ROWS - 1 }, (_, i) => row(`x${i}`, `n${i}`)),
    ];
    const { deps } = setup(rows);
    expect(parseSessionMention("@web hi", deps)?.target).toBe("web");
    expect(parseSessionMention("@n3 hi", deps)).toBeUndefined(); // truncated ⇒ name branch released
  });

  it("legacy name branch in alias mode hands the TOKEN to hub (not row.ref)", () => {
    const { deps } = setup([row("abc123def456", "alice")]);
    expect(parseSessionMention("@alice hi", deps)).toMatchObject({ target: "alice", via: "name" });
  });

  it("miss ⇒ pass through", () => {
    const { deps } = setup([row("B", "b", "web")]);
    expect(parseSessionMention("@other hi", deps)).toBeUndefined();
  });

  it("non-alias mode is byte-identical: ref target, no via, alias ignored", () => {
    const { deps } = setup([row("abc123def456", "alice", "web")], { alias: false });
    expect(parseSessionMention("@alice hi", deps)).toEqual({
      form: "bare",
      target: "abc123def456",
      message: "hi",
      label: "alice",
    });
    expect(parseSessionMention("@web hi", deps)).toBeUndefined();
  });

  it("explicit @session: unchanged in alias mode", () => {
    const { deps } = setup([]);
    expect(parseSessionMention("@session:前端 hi", deps)).toMatchObject({ form: "explicit", target: "前端" });
  });
});

describe("alias completion", () => {
  const base: AutocompleteProvider = {
    async getSuggestions() {
      return null;
    },
    applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: 0 }),
  };
  const opts = () => ({ signal: new AbortController().signal, force: true });

  it("inserts @alias when approved, explicit ref otherwise; prefix matches alias (NFKC/lowercase)", async () => {
    const { deps } = setup([row("B", "b", "web"), row("C", "c", "api")], { labels: ["api"] });
    const provider = createMentionAutocompleteProvider(base, {
      entries: () => [],
      sessions: () => [
        { ref: "B", name: "b", alias: "web", cwdLabel: "~/x", receive: "wake", busy: false },
        { ref: "C", name: "c", alias: "api", cwdLabel: "~/x", receive: "wake", busy: false },
      ],
      sessionBareAlias: (a) => sessionCompletionAlias(deps, a),
    });
    const r = await provider.getSuggestions(["@Ｗe"], 0, 3, opts());
    expect(r?.items.map((i) => i.value)).toEqual(["@web"]);
    expect(r?.items[0]?.description).toContain("@web");
    const all = await provider.getSuggestions(["@"], 0, 1, opts());
    expect(all?.items.map((i) => i.value)).toEqual(["@web", "@session:C"]);
    const byAlias = await provider.getSuggestions(["@ap"], 0, 3, opts());
    expect(byAlias?.items.map((i) => i.value)).toEqual(["@session:C"]);
  });

  it("no alias ⇒ description/value byte-identical to pre-alias", async () => {
    const provider = createMentionAutocompleteProvider(base, {
      entries: () => [],
      sessions: () => [{ ref: "B", name: "b", cwdLabel: "~/x", receive: "wake", busy: false }],
    });
    const r = await provider.getSuggestions(["@"], 0, 1, opts());
    expect(r?.items[0]).toMatchObject({ value: "@session:B", description: "session · ~/x · wake · idle" });
  });
});
