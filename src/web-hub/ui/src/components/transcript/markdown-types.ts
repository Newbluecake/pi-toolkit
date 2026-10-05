/**
 * TS mirror of `@logic/render/markdown.js`'s JSDoc `@typedef`s for `Inline`/`MdNode` (vue-plan.md
 * v2.1 §3.1/§3.10/§5.2 — P4; extended by the markdown-whitelist-extension package with
 * table/quote/del/task-list nodes). The legacy file only exports `parseMarkdown`/`isSafeHref` as
 * plain JS with JSDoc types — no real TS type to import — so `MdBlock.vue`/`MdInline.vue`'s
 * `defineProps` need a hand-written mirror to type-check against. Kept byte-for-byte in sync
 * with the JSDoc by inspection (both are effectively frozen: any real structural change there
 * would already break the widely-used `parseMarkdown`/`isSafeHref` exports' own callers).
 */
export type TableAlign = "" | "left" | "center" | "right";

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong"; readonly children: readonly Inline[] }
  | { readonly type: "em"; readonly children: readonly Inline[] }
  | { readonly type: "del"; readonly children: readonly Inline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly Inline[] };

export type MdNode =
  | { readonly type: "code_block"; readonly lang: string; readonly text: string }
  | { readonly type: "paragraph"; readonly children: readonly Inline[] }
  | { readonly type: "heading"; readonly level: number; readonly children: readonly Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<readonly Inline[]>;
      /**
       * Parallel to `items`, present only when at least one item carried a `- [ ]`/`- [x]`
       * task marker: `null` = plain item, `true`/`false` = read-only task checkbox state.
       */
      readonly checked?: ReadonlyArray<boolean | null>;
    }
  | { readonly type: "quote"; readonly children: readonly MdNode[] }
  | {
      readonly type: "table";
      readonly align: readonly TableAlign[];
      readonly header: ReadonlyArray<readonly Inline[]>;
      readonly rows: ReadonlyArray<ReadonlyArray<readonly Inline[]>>;
    };
