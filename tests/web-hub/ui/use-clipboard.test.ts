// @vitest-environment happy-dom
/**
 * `composables/useClipboard.ts` — the 2026-10-12 legacy execCommand fallback: plain-HTTP LAN
 * (isSecureContext=false, no navigator.clipboard) must copy for REAL via execCommand, and the
 * textarea path must carry newlines byte-exactly (the old select-a-span fallback collapsed
 * them). Failure ordering (insecure-context / unavailable / denied) is pinned for the cases
 * where BOTH paths fail.
 */
import { describe, expect, it } from "vitest";
import { useClipboard, type ClipboardDocument } from "../../../src/web-hub/ui/src/composables/useClipboard.js";

interface FakeTextarea {
  value: string;
  style: { cssText: string };
  attrs: Record<string, string>;
  selected: boolean;
  removed: boolean;
}

function fakeDoc(execResult: boolean | "throw" | "absent") {
  const ta: FakeTextarea = { value: "", style: { cssText: "" }, attrs: {}, selected: false, removed: false };
  const doc: ClipboardDocument & { ta: FakeTextarea } = {
    ta,
    createElement: () => ({
      set value(v: string) {
        ta.value = v;
      },
      get value() {
        return ta.value;
      },
      style: ta.style,
      setAttribute(name: string, value: string) {
        ta.attrs[name] = value;
      },
      select() {
        ta.selected = true;
      },
      remove() {
        ta.removed = true;
      },
    }),
    body: { appendChild() {} },
    ...(execResult === "absent"
      ? {}
      : {
          execCommand: () => {
            if (execResult === "throw") throw new Error("blocked");
            return execResult;
          },
        }),
  };
  return doc;
}

function win(over: {
  secure: boolean;
  writeText?: (() => Promise<void>) | undefined;
  doc?: ClipboardDocument | undefined;
}) {
  return {
    isSecureContext: over.secure,
    navigator: over.writeText ? { clipboard: { writeText: over.writeText } } : {},
    ...(over.doc !== undefined ? { document: over.doc } : {}),
  };
}

describe("useClipboard — legacy execCommand fallback (2026-10-12)", () => {
  it("secure context + writeText ⇒ modern path, execCommand never consulted", async () => {
    let wrote = "";
    const doc = fakeDoc(true);
    const c = useClipboard(win({ secure: true, writeText: async (t: string) => void (wrote = t), doc }));
    expect(await c.copy("hello")).toEqual({ ok: true });
    expect(wrote).toBe("hello");
    expect(doc.ta.selected).toBe(false);
  });

  it("insecure context (plain-HTTP LAN) + no clipboard ⇒ execCommand copies for real", async () => {
    const doc = fakeDoc(true);
    const c = useClipboard(win({ secure: false, doc }));
    expect(await c.copy("line1\nline2")).toEqual({ ok: true });
    // byte-exact: the textarea carried the newline through
    expect(doc.ta.value).toBe("line1\nline2");
    expect(doc.ta.attrs["readonly"]).toBe("");
    expect(doc.ta.removed).toBe(true); // cleanup always runs
  });

  it("secure but writeText throws ⇒ legacy path still saves the gesture", async () => {
    const doc = fakeDoc(true);
    const c = useClipboard(win({ secure: true, writeText: async () => Promise.reject(new Error("denied")), doc }));
    expect(await c.copy("x")).toEqual({ ok: true });
    expect(doc.ta.selected).toBe(true);
  });

  it("insecure + execCommand absent ⇒ insecure-context (pre-fix behavior for select+announce)", async () => {
    const c = useClipboard(win({ secure: false, doc: fakeDoc("absent") }));
    expect(await c.copy("x")).toEqual({ ok: false, reason: "insecure-context" });
  });

  it("insecure + execCommand returns false ⇒ insecure-context (not silently ok)", async () => {
    const c = useClipboard(win({ secure: false, doc: fakeDoc(false) }));
    expect(await c.copy("x")).toEqual({ ok: false, reason: "insecure-context" });
  });

  it("secure + writeText throws + legacy throws ⇒ denied", async () => {
    const c = useClipboard(
      win({ secure: true, writeText: async () => Promise.reject(new Error("x")), doc: fakeDoc("throw") }),
    );
    expect(await c.copy("x")).toEqual({ ok: false, reason: "denied" });
  });

  it("secure + no clipboard + legacy false ⇒ unavailable", async () => {
    const c = useClipboard(win({ secure: true, doc: fakeDoc(false) }));
    expect(await c.copy("x")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("document-less window fake keeps the pre-fix outcomes exactly", async () => {
    const c = useClipboard(win({ secure: false }));
    expect(await c.copy("x")).toEqual({ ok: false, reason: "insecure-context" });
  });
});
