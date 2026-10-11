import type { InjectionKey } from "vue";
import type { AvatarHandle } from "../../composables/useAvatar.js";

/** App-level avatar seam. W (App.vue) provides one handle for the whole page. */
export const AVATAR_CTX: InjectionKey<AvatarHandle> = Symbol("web-hub-avatar");
