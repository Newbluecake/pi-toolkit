// #50 shared, pi-free output admission. No proposal/store/commit authority here.
import { createHash } from "node:crypto";
import { BLOCK_BODY_MAX_BYTES } from "../blocks/format.js";
import { looksSecret } from "../secret-patterns.js";

export type RevisionOutput =
  | { readonly ok: true; readonly body: string; readonly outputDigest: string }
  | { readonly ok: false; readonly reason: "invalid-output" };

/** Only a single Markdown body is accepted, NOT a model-supplied envelope or
 * operation. Conservative syntax rejection is not a semantic safety proof.
 * Never strips frontmatter/schema/fences to turn a refused response into a body.
 * Reuse at proposal custody and commit boundaries, not just at generation. */
export function validateRevisionOutput(raw: unknown): RevisionOutput {
  const invalid = { ok: false, reason: "invalid-output" } as const;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > BLOCK_BODY_MAX_BYTES) return invalid;
  if (/[\u0000-\u0008\u000b-\u001f\u007f\uFEFF]/u.test(raw.replace(/\r\n/g, "\n"))) return invalid;
  // Lone surrogates cannot round-trip UTF-8 and must not share a digest.
  if (Array.from(raw).some((c) => c.length === 1 && /[\ud800-\udfff]/u.test(c))) return invalid;
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (
    body === "" ||
    /^(?:---|\.\.\.)\s*$/m.test(body) ||
    /^[\[{]/.test(body) ||
    // Machine operations are refused wherever embedded, not unwrapped into
    // apparently harmless prose. Includes apply_patch, unified/git diffs,
    // YAML sequence mappings and inline JSON operation envelopes.
    /^\s*\*\*\*\s*(?:Begin Patch|End Patch|(?:Add|Delete|Update|Move) File\s*:)/im.test(body) ||
    /^\s*(?:diff --git\s|\+\+\+\s|@@\s*[-+])/m.test(body) ||
    /"(?:action|op|operations|files|path|generatedBody|outputDigest|suggestions|relation|coverage)"\s*:/i.test(body) ||
    /[\[{,]\s*(?:action|op|operations|files|path)\s*:/i.test(body) ||
    // Verb-as-key envelopes (delete: rules.001 / reason: obsolete) also
    // denote machine operations. Require a file-like scalar or structured
    // value after the key, NOT a bare natural-language deletion keyword.
    /(?:^|[\n[{,])[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?["']?(?:delete|remove|create|write|update|replace|rename|move|copy|retire|archive)["']?[ \t]*:[ \t]*(?:[\[{]|["']?(?:[a-z0-9_@+~-]+(?:\.[a-z0-9_@+~-]+)+|[^\s"'{}\[\],]*[\\/][^\s"'{}\[\],]+)["']?(?=[ \t]*(?:$|[,}\]])))/im.test(
      body,
    ) ||
    /^```(?:json|ya?ml)?\s*$/im.test(body) ||
    /\[(?:REDACTED|PEM|EMAIL)\]/i.test(body) ||
    /<!--\s*mem\b|<\/?(?:tool_call|function_call)\b/i.test(body) ||
    /^\s*(?:(?:[-*+]|\d+[.)])\s+)?["']?(?:body|action|op|path|generatedBody|outputDigest|authority|storageScope|supersedes|supersededBy|expires|operations|files|suggestions|relation|coverage)["']?\s*:/im.test(
      body,
    ) ||
    looksSecret(body)
  )
    return invalid;
  return Object.freeze({ ok: true, body, outputDigest: createHash("sha256").update(body, "utf8").digest("hex") });
}

/** Coverage has a separate, closed response schema. It cannot smuggle a body,
 * probability, relation verdict or a declaration of independence. */
export function validateCoverageOutput(raw: unknown): "complete" | "partial" | "unknown" | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 128) return undefined;
  try {
    // Exact grammar also rejects duplicate keys (JSON.parse alone would not).
    const match = /^\s*\{\s*"verdict"\s*:\s*"(complete|partial|unknown)"\s*\}\s*$/.exec(raw);
    return match?.[1] as "complete" | "partial" | "unknown" | undefined;
  } catch {
    return undefined;
  }
}
