// @vitest-environment happy-dom
/** #44: control-on shows neither the TopBar terminal chip nor the App-level ControlNotice banner;
 * control-off keeps the Read-only chip. Control capability itself is untouched. */
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

function mountBar(control: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const hub = { state: ref({ control } as HubState), dispatch: () => {} } as unknown as HubHandle;
  return mount(TopBar, {
    props: { conn: "open", hubVersion: null, canSignOut: true },
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("#44 redundant control UI removed", () => {
  it("control on: no control chip, no read-only chip; settings + sign-out still there", () => {
    const w = mountBar(true);
    expect(w.find(".control-chip").exists()).toBe(false);
    expect(w.find(".readonly-chip").exists()).toBe(false);
    expect(w.find('[aria-controls="settings-panel"]').exists()).toBe(true);
    w.unmount();
  });
  it("control off: read-only chip unchanged", () => {
    const w = mountBar(false);
    expect(w.find(".readonly-chip").exists()).toBe(true);
    expect(w.find(".control-chip").exists()).toBe(false);
    w.unmount();
  });
  it("App.vue no longer mounts ControlNotice", () => {
    const src = readFileSync("src/web-hub/ui/src/App.vue", "utf8");
    expect(src).not.toMatch(/<ControlNotice/);
  });
});
