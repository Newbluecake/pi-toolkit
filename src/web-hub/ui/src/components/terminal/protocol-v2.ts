/** T51 P0 lazy v2 consumer face. Type aliases, never hand-written duplicate interfaces.
 * No production v1 imports this module; no transport/rendering/create side effects. */
export type {
  TerminalScopeV2,
  TerminalSessionV2,
  TerminalTabRowV2,
  TerminalUnknownResourceV2,
  TerminalStateV2,
  TerminalQuotaV2,
  TerminalTabsV2,
  TerminalMetadataV2,
  TerminalHttpRequestsV2,
  TerminalHttpResultsV2,
  TerminalHttpResponseV2,
  TerminalFailureV2,
  TerminalErrorCodeV2,
  TerminalViewFrameV2,
} from "../../../../protocol/terminal-v2.js";
export { TERMINAL_V2_CAP, TERMINAL_V2_HTTP_PATHS } from "../../../../protocol/terminal-v2-paths.js";
export {
  TERMINAL_V2_LIMITS,
  normalizeTerminalNameV2,
  terminalCwdV2Ok,
  terminalBase64BytesV2,
} from "../../../../protocol/terminal-v2-values.js";
export { TERMINAL_V2_UI_SCHEMAS } from "./protocol-v2-schema.js";
/** Structural checks must be followed by the shared value rules (canonical base64/byte
 * limits/offset overflow/name normalization). ACK readiness/seq/current-view are stateful
 * P2/P4 checks, not facts that a schema can prove. */
export { terminalSchemaCheck } from "./schema-check.js";
