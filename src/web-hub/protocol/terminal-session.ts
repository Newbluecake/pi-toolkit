/** Inert I8 boundary anchor, not a declaration/parser/negotiation surface.
 * The frozen TERMINAL_MIRROR_CLOSURE pins this file and exactly these three edges.
 * Keep those existing edges without changing the whitelist; export NO v1 schema,
 * type or decoder. No production consumer imports this module. Unknown historical
 * status fields remain opaque ordinary status and cannot enable a v2 candidate.
 */
import "@sinclair/typebox";
import "@sinclair/typebox/value";
import "./terminal.js";
