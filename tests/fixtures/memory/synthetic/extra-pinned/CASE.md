Reserved for P1's G2 tiered-render case (`extra-pinned`: at least one
`pin: true` file beyond the primary core, small enough to fit whole-file
into the remaining core budget at a normal budget (fully inlined, no
demotion) — and at a smaller test-supplied budget, demoted into the index
with a `📌` marker (L3), per §2.3 step 4.

- `core.md` — the primary core file, `pin: true`, small (fits easily).
- `pinned-a.md`, `pinned-b.md` — extra `pin: true` files (file-name order
  matters per §2.2's sort rule), each small enough to be inlined whole at
  a normal budget.
- `topic.md` — one ordinary, non-pinned topic file for contrast.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
