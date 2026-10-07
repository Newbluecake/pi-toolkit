import { effectScope, ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  computeWindow,
  DESKTOP_DEFAULT_WINDOW,
  defaultWindowSize,
  defaultWindowStart,
  MOBILE_DEFAULT_WINDOW,
  revealEarlier,
  TRANSCRIPT_CAP,
  useTranscriptWindow,
} from "../../../src/web-hub/ui/src/composables/useTranscriptWindow.js";

describe("useTranscriptWindow (vue-plan.md v2.1 §3.6, §5.2 — P1)", () => {
  describe("computeWindow: pure math", () => {
    it("window fits entirely: end===len, no hidden either side", () => {
      expect(computeWindow({ len: 50, start: 0, cap: 300 })).toEqual({
        start: 0,
        end: 50,
        hiddenBefore: 0,
        hiddenAfter: 0,
      });
    });
    it("start > 0: hiddenBefore reflects it, end still reaches len when under cap", () => {
      expect(computeWindow({ len: 500, start: 300, cap: 300 })).toEqual({
        start: 300,
        end: 500,
        hiddenBefore: 300,
        hiddenAfter: 0,
      });
    });
    it("revealing enough older items to exceed cap shrinks the tail, anchored at start", () => {
      expect(computeWindow({ len: 500, start: 100, cap: 300 })).toEqual({
        start: 100,
        end: 400,
        hiddenBefore: 100,
        hiddenAfter: 100,
      });
    });
    it("start clamps into [0, len]", () => {
      expect(computeWindow({ len: 10, start: -5, cap: 300 })).toEqual({
        start: 0,
        end: 10,
        hiddenBefore: 0,
        hiddenAfter: 0,
      });
      expect(computeWindow({ len: 10, start: 999, cap: 300 })).toEqual({
        start: 10,
        end: 10,
        hiddenBefore: 10,
        hiddenAfter: 0,
      });
    });
    it("len=0: always an empty window", () => {
      expect(computeWindow({ len: 0, start: 0, cap: 300 })).toEqual({
        start: 0,
        end: 0,
        hiddenBefore: 0,
        hiddenAfter: 0,
      });
    });
    it("cap is floored to at least 1", () => {
      expect(computeWindow({ len: 10, start: 0, cap: 0 })).toEqual({
        start: 0,
        end: 1,
        hiddenBefore: 0,
        hiddenAfter: 9,
      });
    });
  });

  describe("defaultWindowStart / revealEarlier / defaultWindowSize", () => {
    it("defaultWindowStart: last N items, clamped at 0", () => {
      expect(defaultWindowStart(500, 200)).toBe(300);
      expect(defaultWindowStart(50, 200)).toBe(0);
    });
    it("revealEarlier: moves start back by pageSize, never below 0", () => {
      expect(revealEarlier(300, 200)).toBe(100);
      expect(revealEarlier(50, 200)).toBe(0);
    });
    it("defaultWindowSize: mobile=80, desktop=200 (plan §0.3)", () => {
      expect(defaultWindowSize(true)).toBe(MOBILE_DEFAULT_WINDOW);
      expect(defaultWindowSize(false)).toBe(DESKTOP_DEFAULT_WINDOW);
      expect(MOBILE_DEFAULT_WINDOW).toBe(80);
      expect(DESKTOP_DEFAULT_WINDOW).toBe(200);
    });
    it("TRANSCRIPT_CAP is 300 (plan §0.2 window cap)", () => {
      expect(TRANSCRIPT_CAP).toBe(300);
    });
  });

  describe("useTranscriptWindow: reactive wrapper", () => {
    it("initializes to the last default-size window and updates as len grows (e.g. streaming)", () => {
      const scope = effectScope();
      scope.run(() => {
        const len = ref(500);
        const isMobile = ref(false);
        const handle = useTranscriptWindow(len, isMobile);
        expect(handle.start.value).toBe(300);
        expect(handle.window.value).toEqual({ start: 300, end: 500, hiddenBefore: 300, hiddenAfter: 0 });
        len.value = 501; // one more streamed item
        expect(handle.window.value.end).toBe(501);
      });
      scope.stop();
    });

    it("showEarlier() reveals pageSize more items, capped at TRANSCRIPT_CAP mounted", () => {
      const scope = effectScope();
      scope.run(() => {
        const len = ref(500);
        const isMobile = ref(false);
        const handle = useTranscriptWindow(len, isMobile);
        handle.showEarlier();
        expect(handle.start.value).toBe(100);
        expect(handle.window.value).toEqual({ start: 100, end: 400, hiddenBefore: 100, hiddenAfter: 100 });
      });
      scope.stop();
    });

    it("resetToLatest() snaps back to the last default-size window", () => {
      const scope = effectScope();
      scope.run(() => {
        const len = ref(500);
        const isMobile = ref(false);
        const handle = useTranscriptWindow(len, isMobile);
        handle.showEarlier();
        handle.resetToLatest();
        expect(handle.start.value).toBe(300);
      });
      scope.stop();
    });

    it("mobile default window is 80", () => {
      const scope = effectScope();
      scope.run(() => {
        const len = ref(500);
        const isMobile = ref(true);
        const handle = useTranscriptWindow(len, isMobile);
        expect(handle.start.value).toBe(420);
      });
      scope.stop();
    });

    // session-switch plan §1.4 (E1-4): the restore path passes a computed start; the window
    // computed clamps it, and omitting it keeps the default tail window.
    describe("initialStart (session-switch plan §1.4 — E1)", () => {
      it("is used verbatim as the start", () => {
        const scope = effectScope();
        scope.run(() => {
          const handle = useTranscriptWindow(ref(500), ref(false), TRANSCRIPT_CAP, 95);
          expect(handle.start.value).toBe(95);
          expect(handle.window.value).toEqual({ start: 95, end: 395, hiddenBefore: 95, hiddenAfter: 105 });
        });
        scope.stop();
      });

      it("out-of-range values are clamped by the window computed (start into [0, len])", () => {
        const scope = effectScope();
        scope.run(() => {
          const tooBig = useTranscriptWindow(ref(100), ref(false), TRANSCRIPT_CAP, 999);
          expect(tooBig.start.value).toBe(999); // raw value kept; the WINDOW clamps
          expect(tooBig.window.value).toEqual({ start: 100, end: 100, hiddenBefore: 100, hiddenAfter: 0 });
          const negative = useTranscriptWindow(ref(100), ref(false), TRANSCRIPT_CAP, -7);
          expect(negative.window.value).toEqual({ start: 0, end: 100, hiddenBefore: 0, hiddenAfter: 0 });
        });
        scope.stop();
      });

      it("omitted ⇒ the default tail window (byte-identical to the pre-E1 default)", () => {
        const scope = effectScope();
        scope.run(() => {
          const handle = useTranscriptWindow(ref(500), ref(false), TRANSCRIPT_CAP, undefined);
          expect(handle.start.value).toBe(300);
        });
        scope.stop();
      });
    });
  });
});
