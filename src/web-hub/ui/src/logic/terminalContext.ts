import type { InjectionKey, Ref } from "vue";
export const TERMINAL_ENTRY: InjectionKey<{
  available: Readonly<Ref<boolean>>;
  open: Readonly<Ref<boolean>>;
  show(): void;
}> = Symbol("terminal-entry");
