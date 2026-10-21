// @vitest-environment happy-dom
/**
 * `PrivacyUnmarkDialog.vue` — the W3 slice only (preview-windows plan r2 §5.2): the topmost
 * overlay decision now comes from the shared `MODAL_OVERLAY_ROOTS` selector, which EXCLUDES
 * the desktop modeless preview-window root. The dialog itself (password/confirm variants,
 * focus return, scroll lock) is exercised through DashboardView elsewhere.
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyUnmarkDialog from "../../../src/web-hub/ui/src/components/privacy/PrivacyUnmarkDialog.vue";

const mounted: Array<ReturnType<typeof mount>> = [];

function mountDialog(mode: "token" | "password" = "token") {
  const w = mount(PrivacyUnmarkDialog, {
    props: { mode, busy: false, error: null },
    attachTo: document.body,
  });
  mounted.push(w);
  return w;
}

function escapeOnBody(): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

describe("PrivacyUnmarkDialog: topmost overlay decision (preview-windows §5.2, W3)", () => {
  it("a MODELESS preview-window root mounted later does NOT block Escape — the dialog stays topmost", async () => {
    const w = mountDialog();
    await Promise.resolve();
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay is-windows is-modeless";
    document.body.appendChild(overlay);
    escapeOnBody();
    await Promise.resolve();
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("a MODAL preview overlay (AttachmentImagePreview-shaped) mounted later still blocks Escape", async () => {
    const w = mountDialog();
    await Promise.resolve();
    const overlay = document.createElement("div");
    overlay.className = "preview-overlay";
    document.body.appendChild(overlay);
    escapeOnBody();
    await Promise.resolve();
    expect(w.emitted("close") ?? []).toHaveLength(0);
  });
});
