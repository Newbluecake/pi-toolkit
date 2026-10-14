import { describe, expect, it } from "vitest";
import {
  MSG_EXPERTS_UNSUPPORTED,
  MSG_PERMISSION_REPLY_FAILED,
  MSG_READONLY_DOMAIN,
  MSG_RESUME_ISOLATION,
  MSG_SET_MODEL_ON_EXTERNAL,
  MSG_SET_MODEL_TO_EXTERNAL,
  MSG_USAGE_EXHAUSTED,
  capabilitiesText,
  externalModelsPromptHeader,
  msgAuthFailure,
  msgBinaryNotFound,
  msgExpertIsExternal,
  msgPermissionUnacknowledged,
  msgProviderNameCollision,
  msgProtocolDrift,
  msgResumeCrossRuntime,
  msgResumeCwdGone,
  msgResumeDisabled,
  msgSchemaNoJson,
  msgUnexpectedCancel,
} from "../../src/external-agent/messages.js";

describe("external-agent messages (plan §2.11)", () => {
  it("frozen constant texts", () => {
    expect(MSG_READONLY_DOMAIN).toBe(
      'toolDomain:"readonly" runs cannot use droid/* models: external agents run with full permissions in this ' +
        "version, so pi-toolkit cannot guarantee read-only execution. Use a pi model for this run.",
    );
    expect(MSG_EXPERTS_UNSUPPORTED).toBe(
      "experts/consult is not supported for droid/* runs (external agents cannot load the consult tool)",
    );
    expect(MSG_RESUME_ISOLATION).toBe(
      "isolation cannot be combined with resuming a droid run: droid sessions are pinned to their original working directory",
    );
    expect(MSG_SET_MODEL_TO_EXTERNAL).toBe("set_model cannot switch to an external-agent model");
    expect(MSG_SET_MODEL_ON_EXTERNAL).toBe("droid external-agent run; mid-run model switching is not supported");
    expect(MSG_USAGE_EXHAUSTED).toBe(
      "droid reports model usage exhausted (Factory subscription/credits) — not a model error, do not retry",
    );
    expect(MSG_PERMISSION_REPLY_FAILED).toBe(
      "failed to answer droid's permission request (stdin closed); pi-toolkit stopped the run",
    );
    expect(msgSchemaNoJson()).toBe(
      "droid run did not end with a parseable ```json block (external agents have no StructuredOutput tool)",
    );
  });

  it("parameterized texts interpolate and stay ASCII-safe", () => {
    expect(msgExpertIsExternal("r_1")).toBe("expert r_1 is a droid external-agent run; consult requires a pi session");
    expect(msgResumeCrossRuntime("r_1", "pi")).toContain("r_1");
    expect(msgResumeCrossRuntime("r_1", "pi")).toContain("pi");
    expect(msgResumeCrossRuntime("r_1", "pi")).toContain("droid");
    expect(msgResumeCrossRuntime("r_1", "droid")).toContain("droid external-agent");
    expect(msgResumeDisabled("r_2")).toContain("externalAgents.droid.enabled");
    expect(msgResumeCwdGone("/tmp/wt-x")).toContain("/tmp/wt-x");
    expect(msgResumeCwdGone("/tmp/wt-x")).toContain("Start a new run instead.");
    expect(msgBinaryNotFound("/opt/droid")).toContain("/opt/droid");
    expect(msgProviderNameCollision("droid")).toContain('"droid"');
  });

  it("msgProtocolDrift carries expected/actual/agentVersion and the escape hatch", () => {
    const text = msgProtocolDrift("1.300.0", "1.264.0", "0.250.0");
    expect(text).toContain("factoryProtocolVersion 1.300.0");
    expect(text).toContain("pinned to 1.264.0");
    expect(text).toContain("(droid 0.250.0)");
    expect(text).toContain('externalAgents.droid.protocolCheck="warn"');
    expect(msgProtocolDrift("1.300.0", "1.264.0")).not.toContain("(droid");
  });

  it("msgAuthFailure embeds the sanitized detail and the FACTORY_API_KEY hint", () => {
    const text = msgAuthFailure("HTTP 402: Organization does not have an active paid subscription");
    expect(text).toContain("HTTP 402: Organization does not have an active paid subscription");
    expect(text).toContain("FACTORY_API_KEY");
    expect(text).toContain("do not retry");
  });

  it("msgUnexpectedCancel appends the permission note only when approvals > 0", () => {
    expect(msgUnexpectedCancel(0)).toBe("droid cancelled the turn unexpectedly");
    expect(msgUnexpectedCancel(1)).toContain("droid cancelled the turn unexpectedly");
    expect(msgUnexpectedCancel(1)).toContain("permission approval may not have been understood by this droid version");
  });

  it("msgPermissionUnacknowledged renders seconds", () => {
    expect(msgPermissionUnacknowledged(10_000)).toContain("within 10s");
    expect(msgPermissionUnacknowledged(15_000)).toContain("within 15s");
  });

  it("capabilitiesText lists exactly the unavailable capabilities (§4.8)", () => {
    const both = capabilitiesText({ canSpawn: false, canMessage: false });
    expect(both).toContain("Unavailable here: consulting experts, messaging other agents, spawning pi sub-agents.");
    expect(both).toContain("with full permissions in your working directory");
    expect(both).toContain("Write every finding into your final answer.");
    expect(capabilitiesText({ canSpawn: true, canMessage: false })).toContain(
      "Unavailable here: consulting experts, messaging other agents.",
    );
    expect(capabilitiesText({ canSpawn: false, canMessage: true })).toContain(
      "Unavailable here: consulting experts, spawning pi sub-agents.",
    );
    expect(capabilitiesText({ canSpawn: true, canMessage: true })).toContain("Unavailable here: consulting experts.");
  });

  it("externalModelsPromptHeader mentions every limitation from §5.3", () => {
    const text = externalModelsPromptHeader("droid");
    expect(text).toContain("`droid/<id>`");
    expect(text).toContain("full permissions");
    expect(text).toContain("resuming is pinned to the original working directory");
    expect(text).toContain("```json block");
    expect(text).toContain("shown as unpriced when unknown");
    expect(text).toContain("Any droid model id is accepted.");
  });
});
