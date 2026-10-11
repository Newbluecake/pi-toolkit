// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import TxUser from "../../../src/web-hub/ui/src/components/transcript/TxUser.vue";
import RunTranscript from "../../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import { AVATAR_CTX } from "../../../src/web-hub/ui/src/components/transcript/avatarContext.js";
import type { AvatarHandle } from "../../../src/web-hub/ui/src/composables/useAvatar.js";

const fake = (src: string | null): AvatarHandle => ({
  best: ref(null),
  src: ref(src),
  preview: ref(null),
  busy: ref(false),
  error: ref(null),
  hasAvatar: computed(() => src !== null),
  observe: () => {},
  upload: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
  remove: async () => ({ ok: false, error: "E_UNSUPPORTED" }),
  refresh: async () => {},
  dispose: () => {},
});

describe("TxUser avatar", () => {
  const props = { text: "hello", truncated: false, timestamp: undefined };
  it("keeps the existing icon DOM without an avatar context", () => {
    const wrapper = mount(TxUser, { props });
    expect(wrapper.find(".avatar-user img").exists()).toBe(false);
    expect(wrapper.find(".avatar-user use").exists()).toBe(true);
  });
  it("keeps the drawer transcript icon even when an avatar is provided above it", () => {
    const agent = {
      key: "A",
      runTx: {
        runId: "r1",
        lastSeq: 0,
        items: [{ id: "r1", kind: "message", message: { role: "user", content: "drawer-msg", timestamp: 1 } }],
        keys: new Set(["r1"]),
        entryIds: new Set(["r1"]),
        uid: 0,
        streaming: null,
        tools: [],
        history: "loaded",
        hasMore: false,
        paging: false,
        terminal: false,
        status: "running",
        live: true,
        retries: 0,
        needsResync: false,
      },
    };
    const wrapper = mount(RunTranscript, {
      props: { agent, now: 0 } as never,
      global: { provide: { [AVATAR_CTX as symbol]: fake("data:image/png;base64,AA==") } },
    });
    expect(wrapper.find(".avatar-user img").exists()).toBe(false);
    expect(wrapper.find(".avatar-user use").exists()).toBe(true);
  });

  it("uses the uploaded image and falls back to the icon on error", async () => {
    const wrapper = mount(TxUser, {
      props,
      global: { provide: { [AVATAR_CTX as symbol]: fake("data:image/png;base64,AA==") } },
    });
    const image = wrapper.find(".avatar-user img");
    expect(image.exists()).toBe(true);
    await image.trigger("error");
    expect(wrapper.find(".avatar-user img").exists()).toBe(false);
    expect(wrapper.find(".avatar-user use").exists()).toBe(true);
  });
});
