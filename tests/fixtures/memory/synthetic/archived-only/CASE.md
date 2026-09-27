Reserved for P1's G2 tiered-render case (`archived-only`: every
addressable file has `status: archived` and there are no active files at
all ⇒ per §2.3's tail rule ("无剩余项但有 archived ⇒ `- (+M archived)`"),
the index has zero listable lines and the tail degenerates to the bare
`- (+M archived)` line — distinct from the "no listable items at all"
(`tailKind: "none"`) case, since M > 0 here.

- `archived-a.md`, `archived-b.md` — both `status: archived`, neither
  pinned. Archived files never appear in the index individually and are
  never inlined (§2.1's "archived" row), only counted.

Not consumed by any P0-a test (renderTiered doesn't exist yet; `status`
frontmatter isn't read by the legacy renderer at all, §2.1 vs §3.1).
Reserved per §14.2 ownership (whole `synthetic/` tree is P0-a-owned,
single writer) so P1 only ever needs to READ this directory.
