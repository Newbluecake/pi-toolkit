Reserved for P1's G2 tiered-render case (`no-core`: no `core.md` and no
`pin: true` file at all ⇒ per §2.1's primary-core admission rule there is
no primary (not even a degraded pin-based one) ⇒ the rendered block has
NO `### <primary>` core section at all, only the header/guide/index/tail.

- `topic-a.md`, `topic-b.md` — two small, non-pinned, non-archived topic
  files. Neither is named `core.md` and neither sets `pin: true`.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
