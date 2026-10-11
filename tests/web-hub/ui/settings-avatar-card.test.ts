// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import SettingsAvatarCard from "../../../src/web-hub/ui/src/components/shell/SettingsAvatarCard.vue";
import { AVATAR_CTX } from "../../../src/web-hub/ui/src/components/transcript/avatarContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AvatarHandle } from "../../../src/web-hub/ui/src/composables/useAvatar.js";

function fakeAvatar(): AvatarHandle {
  return {
    best: ref(null),
    src: ref(null),
    preview: ref(null),
    busy: ref(false),
    error: ref(null),
    hasAvatar: computed(() => false),
    observe: () => {},
    upload: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
    remove: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
    refresh: async () => {},
    dispose: () => {},
  };
}
const hub = { state: ref({ hub: { caps: ["avatar.v1"] } }) } as never;

describe("SettingsAvatarCard", () => {
  it("does not render without the avatar cap", () => {
    const wrapper = mount(SettingsAvatarCard, {
      global: {
        provide: { [HUB_CTX as symbol]: { state: ref({ hub: { caps: [] } }) }, [AVATAR_CTX as symbol]: fakeAvatar() },
      },
    });
    expect(wrapper.find(".settings-avatar-card").exists()).toBe(false);
  });
  it("renders the upload controls when the cap is present", () => {
    const wrapper = mount(SettingsAvatarCard, {
      global: { provide: { [HUB_CTX as symbol]: hub, [AVATAR_CTX as symbol]: fakeAvatar() } },
    });
    expect(wrapper.find(".settings-avatar-card").exists()).toBe(true);
    expect(wrapper.find(".avatar-upload").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".avatar-file-input").exists()).toBe(true);
  });
});
