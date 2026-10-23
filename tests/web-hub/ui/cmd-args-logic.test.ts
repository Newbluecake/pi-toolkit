/**
 * `@logic/cmdArgs.js` pure units (web-hub-slash-args plan §6/§8 — P3): the arg-zone parser
 * boundaries, apply semantics, the D2/#5 key map, the defensive response parser/second trim,
 * and the backstep-only LRU cache. The hand-mirrored budget constants are pinned against the
 * P0-frozen `CMD_ARGS` block (`@protocol/command-args.ts`) so the UI can never drift from the
 * protocol (same anti-drift rule as `logic-contract.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { CMD_ARGS } from "@protocol/command-args.ts";
import {
  applyArgItem,
  ARG_CACHE_MAX,
  ARG_CACHE_TTL_MS,
  ARG_CLIENT_TIMEOUT_MS,
  ARG_DEBOUNCE_MS,
  ARG_ITEM_DESC_MAX_CHARS,
  ARG_ITEM_LABEL_MAX_CHARS,
  ARG_ITEM_MAX,
  ARG_ITEM_VALUE_MAX_BYTES,
  ARG_ITEMS_TOTAL_MAX_BYTES,
  ARG_LOADING_HINT_DELAY_MS,
  ARG_PREFIX_MAX_BYTES,
  ARG_RATE_PAUSE_FLOOR_MS,
  argCacheGet,
  argCacheKey,
  argCacheSet,
  argKeyAction,
  argZone,
  parseCompleteResponse,
} from "../../../src/web-hub/ui/src/logic/cmdArgs.js";

// ---------------------------------------------------------------------------
// §8: budget constants pinned against the P0-frozen protocol block
// ---------------------------------------------------------------------------

describe("cmdArgs constants mirror CMD_ARGS (P0 frozen)", () => {
  it("every UI-side entry equals its protocol counterpart", () => {
    expect(ARG_PREFIX_MAX_BYTES).toBe(CMD_ARGS.prefixMaxBytes);
    expect(ARG_ITEM_MAX).toBe(CMD_ARGS.itemMax);
    expect(ARG_ITEM_VALUE_MAX_BYTES).toBe(CMD_ARGS.itemValueMaxBytes);
    expect(ARG_ITEM_LABEL_MAX_CHARS).toBe(CMD_ARGS.itemLabelMaxChars);
    expect(ARG_ITEM_DESC_MAX_CHARS).toBe(CMD_ARGS.itemDescMaxChars);
    expect(ARG_ITEMS_TOTAL_MAX_BYTES).toBe(CMD_ARGS.itemsTotalMaxBytes);
    expect(ARG_CLIENT_TIMEOUT_MS).toBe(CMD_ARGS.clientTimeoutMs);
    expect(ARG_DEBOUNCE_MS).toBe(CMD_ARGS.debounceMs);
    expect(ARG_LOADING_HINT_DELAY_MS).toBe(CMD_ARGS.loadingHintDelayMs);
    expect(ARG_CACHE_TTL_MS).toBe(CMD_ARGS.cacheTtlMs);
    expect(ARG_CACHE_MAX).toBe(CMD_ARGS.cacheMax);
    expect(ARG_RATE_PAUSE_FLOOR_MS).toBe(CMD_ARGS.ratePauseFloorMs);
  });
});

// ---------------------------------------------------------------------------
// argZone boundaries (§8: `/a`, `/a␠`, `/a␠␠x`, `//`, tab, newline, caret≠end, >1KiB)
// ---------------------------------------------------------------------------

describe("argZone", () => {
  const z = (text: string, caret?: number) => argZone(text, caret);

  it("opens on `/name ` with the prefix after exactly one U+0020", () => {
    expect(z("/cache-ttl ")).toEqual({ name: "cache-ttl", argStart: 11, prefix: "" });
    expect(z("/cache-ttl keepalive")).toEqual({ name: "cache-ttl", argStart: 11, prefix: "keepalive" });
    // spaces INSIDE the prefix are fine (multi-token arguments)
    expect(z("/cache-ttl keepalive on").prefix).toBe("keepalive on");
    // a second space right after the first is part of the prefix, not another separator
    expect(z("/a  x")).toEqual({ name: "a", argStart: 3, prefix: " x" });
  });

  it("stays closed for every v1 boundary (§10)", () => {
    expect(z("/a")).toBeUndefined(); // no space yet — still the NAME zone
    expect(z("/a\t")).toBeUndefined(); // tab is NOT a separator
    expect(z("//escaped")).toBeUndefined(); // the send-as-text escape
    expect(z("//a x")).toBeUndefined();
    expect(z("/a x\nmore")).toBeUndefined(); // multiline
    expect(z("/a x\r")).toBeUndefined();
    expect(z("/a x", 2)).toBeUndefined(); // caret not at the end
    expect(z("/a x", 3)).toBeUndefined();
    expect(z("hello /a x")).toBeUndefined(); // not slash-initial
    expect(z("")).toBeUndefined();
  });

  it("defaults the caret to the end (the only v1-supported position)", () => {
    expect(argZone("/a b")).toEqual({ name: "a", argStart: 3, prefix: "b" });
  });

  it("rejects a prefix over 1 KiB UTF-8 (bytes, not chars)", () => {
    const ascii = `/a ${"x".repeat(ARG_PREFIX_MAX_BYTES)}`;
    expect(argZone(ascii)).toBeDefined();
    expect(argZone(`/a ${"x".repeat(ARG_PREFIX_MAX_BYTES + 1)}`)).toBeUndefined();
    // 2-byte chars: half the chars, same byte budget
    expect(argZone(`/a ${"é".repeat(ARG_PREFIX_MAX_BYTES / 2)}`)).toBeDefined();
    expect(argZone(`/a ${"é".repeat(ARG_PREFIX_MAX_BYTES / 2 + 1)}`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyArgItem — whole-prefix replacement (pi-tui applyCompletion semantics)
// ---------------------------------------------------------------------------

describe("applyArgItem", () => {
  it("replaces the whole prefix (multi-token values embed the typed tokens)", () => {
    expect(applyArgItem("cache-ttl", { value: "keepalive on", label: "keepalive on" })).toBe("/cache-ttl keepalive on");
    expect(applyArgItem("webhub", { value: "stop", label: "stop" })).toBe("/webhub stop");
  });
});

// ---------------------------------------------------------------------------
// argKeyAction — D2 (Enter applies only after explicit navigation) + IME never taken
// ---------------------------------------------------------------------------

describe("argKeyAction", () => {
  // Plain objects (node env — no DOM); argKeyAction only reads key/isComposing/keyCode/shift/alt.
  const ev = (key: string, init: Record<string, unknown> = {}): Record<string, unknown> => ({
    key,
    isComposing: false,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it("maps the navigation/apply/close keys", () => {
    expect(argKeyAction(ev("ArrowDown"))).toBe("down");
    expect(argKeyAction(ev("ArrowUp"))).toBe("up");
    expect(argKeyAction(ev("Tab", { shiftKey: true }))).toBe("up");
    expect(argKeyAction(ev("Tab"))).toBe("apply");
    expect(argKeyAction(ev("Escape"))).toBe("close");
  });

  it("D2: Enter applies ONLY when navigated; otherwise it is not ours", () => {
    expect(argKeyAction(ev("Enter"))).toBeNull();
    expect(argKeyAction(ev("Enter"), { navigated: true })).toBe("apply");
    // modifiers keep the normal composer key map (Shift+Enter newline, Alt+Enter followUp)
    expect(argKeyAction(ev("Enter", { shiftKey: true }), { navigated: true })).toBeNull();
    expect(argKeyAction(ev("Enter", { altKey: true }), { navigated: true })).toBeNull();
  });

  it("IME keys are never taken (isComposing / keyCode 229)", () => {
    expect(argKeyAction(ev("ArrowDown", { isComposing: true }))).toBeNull();
    expect(argKeyAction(ev("Enter", { isComposing: true }), { navigated: true })).toBeNull();
    expect(argKeyAction(ev("Enter", { keyCode: 229 }), { navigated: true })).toBeNull();
  });

  it("any other key is not ours", () => {
    expect(argKeyAction(ev("a"))).toBeNull();
    expect(argKeyAction(ev("Home"))).toBeNull();
    expect(argKeyAction(ev("Backspace"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCompleteResponse — shape defense + client second trim
// ---------------------------------------------------------------------------

describe("parseCompleteResponse", () => {
  it("accepts a well-formed body and passes sanitized items through", () => {
    const body = {
      items: [
        { value: "keepalive", label: "keepalive", description: "cache keepalive" },
        { value: "status", label: "status", policy: "confirm" },
      ],
      source: "own",
    };
    expect(parseCompleteResponse(body)).toEqual({
      items: [
        { value: "keepalive", label: "keepalive", description: "cache keepalive" },
        { value: "status", label: "status", policy: "confirm" },
      ],
      truncated: false,
    });
  });

  it("rejects non-bodies without throwing (silent degrade)", () => {
    expect(parseCompleteResponse(undefined)).toBeUndefined();
    expect(parseCompleteResponse(null)).toBeUndefined();
    expect(parseCompleteResponse("nope")).toBeUndefined();
    expect(parseCompleteResponse({})).toBeUndefined(); // items missing
    expect(parseCompleteResponse({ items: "x" })).toBeUndefined();
  });

  it("drops malformed items and dedupes by value (first wins)", () => {
    const out = parseCompleteResponse({
      items: [
        null,
        { value: "", label: "empty" }, // empty value
        { value: " x", label: "leading space" },
        { value: "a\nb", label: "newline" },
        { value: "ok", label: "" }, // empty label
        { value: "ok2", label: 5 }, // non-string label
        { value: "good", label: "good", extra: "ignored" },
        { value: "good", label: "dup" }, // dedupe
        { value: "d", label: "d", description: 7 }, // non-string description dropped
        { value: "c", label: "c", policy: "deny" }, // only "confirm" survives: field dropped, item kept
        { value: "p", label: "p", policy: "confirm" },
      ],
    });
    expect(out?.items).toEqual([
      { value: "good", label: "good" },
      { value: "d", label: "d" },
      { value: "c", label: "c" },
      { value: "p", label: "p", policy: "confirm" },
    ]);
    expect(out?.truncated).toBe(false);
  });

  it("trims to 50 items with truncated:true", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ value: `v${i}`, label: `v${i}` }));
    const out = parseCompleteResponse({ items });
    expect(out?.items.length).toBe(ARG_ITEM_MAX);
    expect(out?.truncated).toBe(true);
    expect(out?.items[49]).toEqual({ value: "v49", label: "v49" });
  });

  it("drops over-cap values (bytes) and over-cap labels/descriptions (chars) entirely", () => {
    expect(parseCompleteResponse({ items: [{ value: "x".repeat(513), label: "l" }] })?.items).toEqual([]);
    expect(parseCompleteResponse({ items: [{ value: `${"x".repeat(512)}`, label: "l" }] })?.items).toHaveLength(1);
    expect(parseCompleteResponse({ items: [{ value: "é".repeat(256 + 1), label: "l" }] })?.items).toEqual([]); // 2B/char
    expect(
      parseCompleteResponse({ items: [{ value: "v", label: "l".repeat(ARG_ITEM_LABEL_MAX_CHARS + 1) }] })?.items,
    ).toEqual([]);
    expect(
      parseCompleteResponse({
        items: [{ value: "v", label: "l", description: "d".repeat(ARG_ITEM_DESC_MAX_CHARS + 1) }],
      })?.items,
    ).toEqual([{ value: "v", label: "l" }]); // over-cap description dropped, item kept
  });

  it("stops at the 16 KiB total budget with truncated:true", () => {
    // distinct 512-byte values (dedup would collapse identical ones)
    const items = Array.from({ length: 60 }, (_, i) => ({
      value: `${"x".repeat(502)}${String(i).padStart(10, "0")}`,
      label: "l".repeat(120),
    }));
    const out = parseCompleteResponse({ items });
    expect(out?.items.length).toBeLessThan(60);
    expect(out?.items.length).toBeGreaterThan(0);
    expect(out?.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// backstep-only result cache (exact-prefix hits, TTL, LRU)
// ---------------------------------------------------------------------------

describe("arg cache", () => {
  it("keys on agentKey|name|prefix", () => {
    expect(argCacheKey("a", "webhub", "st")).toBe("a|webhub|st");
  });

  it("returns fresh hits and expires stale ones", () => {
    const cache = new Map();
    argCacheSet(cache, "k", [{ value: "v", label: "v" }], 1_000);
    expect(argCacheGet(cache, "k", 1_000 + ARG_CACHE_TTL_MS - 1)).toEqual([{ value: "v", label: "v" }]);
    expect(argCacheGet(cache, "k", 1_000 + ARG_CACHE_TTL_MS + 1)).toBeUndefined();
    expect(cache.has("k")).toBe(false); // expired entry evicted
  });

  it("is an LRU capped at 64 entries (oldest evicted, reads touch recency)", () => {
    const cache = new Map();
    for (let i = 0; i < ARG_CACHE_MAX; i++) argCacheSet(cache, `k${i}`, [], 0);
    expect(argCacheGet(cache, "k0", 1)).toEqual([]); // touch the oldest
    argCacheSet(cache, "kNew", [], 1); // over cap ⇒ evicts k1 (k0 was touched)
    expect(cache.has("k0")).toBe(true);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("kNew")).toBe(true);
    expect(cache.size).toBe(ARG_CACHE_MAX);
  });
});
