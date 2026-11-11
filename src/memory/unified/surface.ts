import { Type } from "@sinclair/typebox";

const S = () => Type.Optional(Type.String());
export const MemoryToolParamsV4 = Type.Object(
  {
    command: Type.Union(["view", "create", "update", "delete", "search"].map((s) => Type.Literal(s))),
    scope: Type.Optional(
      Type.Union(
        ["project", "session", "hub", "all"].map((s) => Type.Literal(s)),
        { default: "project" },
      ),
    ),
    path: S(),
    id: S(),
    text: S(),
    rev: S(),
    query: S(),
    topic: S(),
    from: S(),
    authority: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("user")])),
  },
  { additionalProperties: false },
);
const DESCRIPTION =
  "Memory: view/create/update/delete/search; scope defaults to project. memory covers project/session/Hub; scoped_memory is the session/Hub compatibility alias. all is read-only: view accepts only command+scope; search also requires query. Project blocks: view [path|topic]; create topic+text; update path+rev+text (whole block); delete path [rev]. Project forbids id/from/authority. Session/Hub forbid path; view [id], update/delete require id+actual rev from view; create omits id/rev. Session forbids topic; Hub create requires topic. from=session:nN|project:<reference> is provenance, not permission. Scoped search: nonempty literal substring, case-insensitive body match, id order, first 50 per scope. Session defaults to agent; user writes or changes to user items require exact-content human approval. Hub is shared by ALL projects, always user authority (authority input ignored); all writes need a proven human turn and exact-content dialog approval (terminal/web), otherwise refusal, never queued. Child accepts no explicit authority, cannot access Hub, and project is read-only with scopes on. Per body 1024B; session 48 items/8192B; Hub 32/4096B. update replaces the full body; delete uses the current body. all returns groups+scopeStatus+partial; failed groups are omitted. Errors carry code/message; project errors preserve originalCode/originalMessage. Never store secrets.";
/** Declared 0.12 Jev inline-authority variant; non-Jev surfaces stay byte-identical. */
const JEV_INLINE_AUTHORITY_DESCRIPTION =
  " Project writes use Jev tagging. Metadata goes on text's first line: " +
  '<!-- mem user|lesson scope=global audience=main|child expires=YYYY-MM-DD until="…" supersedes=id tags=+a,-b private -->. ' +
  "Use bare user for user orders (e.g. <!-- mem user -->), lesson for agent experience. " +
  "authority: user is stored frontmatter, not an inline key; authority= is invalid. Project rejects top-level authority.";
export function memoryV4Surface(options: { child?: boolean; jev?: boolean } = {}) {
  return {
    description:
      DESCRIPTION +
      (options.child ? " Current session is a child: omit authority; Hub is unavailable." : "") +
      (options.jev ? JEV_INLINE_AUTHORITY_DESCRIPTION : ""),
    promptSnippet: "Memory by scope; project is default. Read before CAS writes.",
    promptGuidelines: ["Use view for actual rev; never invent revisions. all never writes."],
    parameters: MemoryToolParamsV4,
  };
}

/** UTF-8 wire budget, deliberately independent of canonical fixture serialization. */
export function measureMemorySurface(surface: {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: unknown;
}): number {
  return Buffer.byteLength(
    surface.description +
      (surface.promptSnippet ?? "") +
      (surface.promptGuidelines ?? []).join("\n") +
      JSON.stringify(surface.parameters),
    "utf8",
  );
}
