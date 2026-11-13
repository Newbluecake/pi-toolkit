import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_WAIT_MS,
  terminalFontsReady,
  waitTerminalFonts,
  watchTerminalFonts,
  loadTerminalFontSize,
  saveTerminalFontSize,
} from "../../../src/web-hub/ui/src/components/terminal/fonts.js";

afterEach(() => vi.useRealTimers());
describe("terminal system monospace font readiness", () => {
  it("orders named system monospace/CJK before generic aliases without font assets", () => {
    expect(TERMINAL_FONT_FAMILY.indexOf('"Noto Sans Mono CJK SC"')).toBeLessThan(
      TERMINAL_FONT_FAMILY.indexOf("ui-monospace"),
    );
    expect(TERMINAL_FONT_FAMILY).toContain('"DejaVu Sans Mono"');
    expect(TERMINAL_FONT_FAMILY).not.toMatch(/url\(|https?:/);
  });
  it("waits for both FontFaceSet.load and ready before xterm measurement", async () => {
    let loaded!: () => void, ready!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((r) => {
          loaded = r;
        }),
    );
    const doc = {
      fonts: {
        load,
        ready: new Promise<void>((r) => {
          ready = r;
        }),
      },
    } as unknown as Document;
    let settled = false;
    const work = terminalFontsReady(doc, 15).then(() => {
      settled = true;
    });
    expect(load).toHaveBeenCalledWith(`15px ${TERMINAL_FONT_FAMILY}`, "Wim中文");
    loaded();
    await Promise.resolve();
    expect(settled).toBe(false);
    ready();
    await work;
    expect(settled).toBe(true);
  });
  it("falls through at the bounded wait but the same late readiness can still remeasure", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    const lateMeasure = vi.fn();
    void ready.then(lateMeasure);
    let opened = false;
    const wait = waitTerminalFonts(ready, new AbortController().signal).then(() => {
      opened = true;
    });
    await vi.advanceTimersByTimeAsync(TERMINAL_FONT_WAIT_MS - 1);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(opened).toBe(true);
    expect(lateMeasure).not.toHaveBeenCalled();
    release();
    await Promise.resolve();
    expect(lateMeasure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending font wait immediately and cleans the deadline", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const work = waitTerminalFonts(new Promise<void>(() => {}), abort.signal);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await work;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("remeasures on real FontFaceSet events, but late readiness cannot reach a disposed terminal", async () => {
    const events = new EventTarget();
    const doc = { fonts: events } as unknown as Document;
    let ready!: () => void;
    const promise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const measure = vi.fn();
    const stop = watchTerminalFonts(doc, promise, measure);
    events.dispatchEvent(new Event("loadingdone"));
    expect(measure).toHaveBeenCalledOnce();
    stop();
    events.dispatchEvent(new Event("loadingdone"));
    ready();
    await Promise.resolve();
    expect(measure).toHaveBeenCalledOnce();
  });
  it("records only a bounded non-secret UI font-size preference, restoring it after reload", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } as Storage;
    expect(loadTerminalFontSize(storage)).toBe(14);
    saveTerminalFontSize(18, storage);
    expect(loadTerminalFontSize(storage)).toBe(18);
    expect([...values]).toEqual([["pwh_terminal_font_size", "18"]]);
    values.set("pwh_terminal_font_size", "999");
    expect(loadTerminalFontSize(storage)).toBe(14);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(loadTerminalFontSize(throwing)).toBe(14);
    saveTerminalFontSize(15, throwing);
    expect([...values]).toEqual([["pwh_terminal_font_size", "999"]]);
  });
});
