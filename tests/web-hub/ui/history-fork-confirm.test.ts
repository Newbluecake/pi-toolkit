// @vitest-environment happy-dom
/**
 * `HistoryForkConfirm.vue` (session-history plan §4.7.2/§4.7.3 — P-ui): the six body texts
 * (open/card, open/managed, maybe/proc, subagent, manual, unverified), the five proof-gap
 * mappings inside the unverified body, the LAN plaintext warning, the W1–W7 best-effort
 * footer, and focus entering the confirm button on mount.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import HistoryForkConfirm from "../../../src/web-hub/ui/src/components/spawn/HistoryForkConfirm.vue";
import type { ForkReason, ProofGap } from "../../../src/web-hub/protocol/session-history.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

/** HistoryForkConfirm has no Teleport of its own — it renders inline in the VTU wrapper. */
function text(props: {
  reason: ForkReason | "manual";
  by?: "card" | "managed" | "proc";
  gap?: ProofGap;
  pid?: number;
  plaintext?: boolean;
}): string {
  const w = mount(HistoryForkConfirm, {
    props: { reason: props.reason, by: props.by, gap: props.gap, pid: props.pid, plaintext: props.plaintext ?? false },
  });
  mounted.push(w);
  return w.element.textContent ?? "";
}

describe("HistoryForkConfirm: the six body texts", () => {
  it("open/card — occupancy by a web session", () => {
    expect(text({ reason: "open", by: "card" })).toContain("open by a web session");
  });

  it("open/managed — occupancy by a managed pi process", () => {
    expect(text({ reason: "open", by: "managed" })).toContain("open by a managed pi process");
  });

  it("maybe/proc — an unconnected pi (pid interpolated via textContent)", () => {
    const t = text({ reason: "maybe", by: "proc", pid: 313 });
    expect(t).toContain("not connected to the hub (pid 313)");
    expect(t).toContain("copy will be started");
  });

  it("subagent — always a copy", () => {
    expect(text({ reason: "subagent" })).toContain("subagent session");
  });

  it("manual — the user-chosen fork", () => {
    expect(text({ reason: "manual" })).toContain("A copy of this session will be started");
  });

  it("unverified — the {gap} placeholder is filled by the gap text", () => {
    const t = text({ reason: "unverified", gap: "proc-partial" });
    expect(t).toContain("cannot be confirmed that this session is not currently open");
    expect(t).toContain("(the process scan did not complete)");
  });
});

describe("HistoryForkConfirm: the five gap mappings", () => {
  const cases: Array<[ProofGap, string]> = [
    ["kind", "cannot tell whether this is a main session"],
    ["unconnected-pi", "a pi process not connected to the hub exists (pid 7)"],
    ["card-unproven", "a pi process that has not reported its session yet exists (pid 7)"],
    ["proc-partial", "the process scan did not complete"],
    ["new-process", "a new pi/node process started during the check"],
  ];
  it.each(cases)("%s ⇒ its own gap line", (gap, fragment) => {
    expect(text({ reason: "unverified", gap, pid: 7 })).toContain(fragment);
  });

  it("an absent gap degrades to the proc-partial line (never an empty placeholder)", () => {
    expect(text({ reason: "unverified" })).toContain("the process scan did not complete");
  });
});

describe("HistoryForkConfirm: chrome", () => {
  it("renders the W1–W7 best-effort footer (W5/W7 fragments)", () => {
    const t = text({ reason: "manual" });
    expect(t).toContain("pid is reused by a new process");
    expect(t).toContain("swapped out and swapped back");
  });

  it("plaintext adds the LAN warning; absent without it", () => {
    expect(text({ reason: "manual", plaintext: true })).toContain("Plain HTTP");
    expect(text({ reason: "manual" })).not.toContain("Plain HTTP");
  });

  it("busy disables both buttons and forwards confirm/cancel", async () => {
    const w = mount(HistoryForkConfirm, {
      props: { reason: "manual", plaintext: false, busy: true },
      attachTo: document.body,
    });
    mounted.push(w);
    const [cancel, run] = Array.from(w.element.querySelectorAll<HTMLButtonElement>(".spawn-confirm-actions button"));
    expect(cancel?.disabled).toBe(true);
    expect(run?.disabled).toBe(true);
    run?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(w.emitted("confirm")).toBeUndefined(); // busy swallows nothing — the button is disabled
    await w.setProps({ busy: false });
    run?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(w.emitted("confirm")).toHaveLength(1);
    cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("focus lands on the primary 「复制并启动」 button on mount (the view swap dropped focus)", async () => {
    const w = mount(HistoryForkConfirm, { props: { reason: "manual", plaintext: false }, attachTo: document.body });
    mounted.push(w);
    await flushPromises();
    expect(document.activeElement).toBe(w.element.querySelector(".spawn-confirm-actions .btn-primary"));
  });

  it("a busy resend does not grab focus (the buttons are disabled anyway)", async () => {
    const w = mount(HistoryForkConfirm, {
      props: { reason: "manual", plaintext: false, busy: true },
      attachTo: document.body,
    });
    mounted.push(w);
    await flushPromises();
    expect(document.activeElement).not.toBe(w.element.querySelector(".spawn-confirm-actions .btn-primary"));
  });
});
