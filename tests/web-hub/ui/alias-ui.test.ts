// @vitest-environment happy-dom
/** alias-plan r4 §7/§9 ALU: alias display surfaces (card chip, header, @ panel, xs message)
 *  and the ChannelsDialog alias section (validate / suggest / save / clear / take). */
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTakeConfirmLine } from "../../../src/web-hub/protocol/xs-alias.js";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import {
  aliasChipText,
  aliasSuggestions,
  toAgentCardView,
  truncateGraphemes,
  XS_ALIAS_CARD_GRAPHEMES,
  xsAliasOf,
} from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import ChannelsDialog from "../../../src/web-hub/ui/src/components/detail/ChannelsDialog.vue";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  filterSessionTargets,
  sessionMentionTargets,
} from "../../../src/web-hub/ui/src/components/control/sessionMention.js";
import TxCustom from "../../../src/web-hub/ui/src/components/transcript/TxCustom.vue";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import { ALIAS_EXTRA } from "../../../src/web-hub/ui/src/i18n/alias-extra.js";
import { parseXsMessage } from "../../../src/web-hub/ui/src/logic/xsMessage.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import { setDetailedListForTests } from "./helpers/list-density.js";
beforeEach(setDetailedListForTests);

const CAPS = ["xs.v1", "xs.channel.v1", "xs.alias.v1"];
const TOKEN = "k0123456789abcdef";

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

const ag = (
  key: string,
  xs: Record<string, unknown> | undefined,
  sid = key + "-0123456789abcdef",
  over: { cwd?: string; name?: string } = {},
): AgentState =>
  ({
    key,
    card: { agentKey: key, kind: "tui", state: "live", cwd: over.cwd ?? "/w/" + key },
    session: { sessionId: sid, name: over.name ?? key, ...(over.cwd ? { cwd: over.cwd } : {}) },
    status: xs === undefined ? {} : { xs: { receive: "wake", blocked: 0, ...xs } },
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  }) as unknown as AgentState;

const hubOf = (agents: AgentState[], caps: unknown = CAPS): HubHandle =>
  ({
    state: ref({ agents: new Map(agents.map((a) => [a.key, a])), hub: { caps } } as unknown as HubState),
    dispatch() {},
  }) as unknown as HubHandle;

// --------------------------------------------------------------------------- model

describe("model", () => {
  it("xsAliasOf is cap-gated and field-gated", () => {
    expect(xsAliasOf(ag("a", { joined: true, alias: "前端" }), CAPS)).toBe("前端");
    expect(xsAliasOf(ag("a", { joined: true, alias: "前端" }), ["xs.v1", "xs.channel.v1"])).toBeUndefined();
    expect(xsAliasOf(ag("a", { joined: true }), CAPS)).toBeUndefined();
    expect(xsAliasOf(ag("a", { joined: true, alias: "" }), CAPS)).toBeUndefined();
    expect(xsAliasOf(ag("a", { joined: true, alias: 7 }), CAPS)).toBeUndefined();
    expect(xsAliasOf(undefined, CAPS)).toBeUndefined();
  });

  it("truncateGraphemes / aliasChipText: first 8 grapheme clusters (Q8)", () => {
    const long = "前端开发工作台一二三四五"; // 12 clusters
    const t = truncateGraphemes(long, XS_ALIAS_CARD_GRAPHEMES);
    expect(t).toEqual({ text: "前端开发工作台一", truncated: true });
    expect(aliasChipText(long)).toBe("@前端开发工作台一…");
    expect(aliasChipText("web")).toBe("@web");
    expect(truncateGraphemes("abc", 8)).toEqual({ text: "abc", truncated: false });
  });

  it("aliasSuggestions: cwd basename, session-name first run, CJK cwd run; dedupe; taken mark", () => {
    const self = ag("s", { joined: true }, "s-0123456789abcdef", { cwd: "/home/u/shop-front", name: "web-hub 重构" });
    const other = ag("o", { joined: true, alias: "shop-front" });
    const out = aliasSuggestions(
      self,
      new Map([
        ["s", self],
        ["o", other],
      ]),
      CAPS,
    );
    expect(out.map((s) => s.alias)).toEqual(["shop-front", "web-hub"]);
    expect(out[0]!.taken).toBe(true);
    expect(out[1]!.taken).toBe(false);
    // a reserved prefix (pi-…) is dropped, never suggested
    const pref = ag("s", { joined: true }, "s-0123456789abcdef", { cwd: "/home/u/pi-toolkit", name: "!!!" });
    expect(aliasSuggestions(pref, new Map([["s", pref]]), CAPS).map((s) => s.alias)).toEqual([]);
  });

  it("aliasSuggestions: CJK segment, current alias skipped, invalid dropped, max 3, cap-gated", () => {
    const self = ag("s", { joined: true, alias: "pi-toolkit" }, "s-0123456789abcdef", {
      cwd: "/home/u/重构前端",
      name: "!!!",
    });
    expect(aliasSuggestions(self, new Map([["s", self]]), CAPS)).toEqual([{ alias: "重构前端", taken: false }]);
    expect(aliasSuggestions(self, new Map([["s", self]]), ["xs.v1"])).toEqual([]);
    expect(aliasSuggestions(undefined, new Map(), CAPS)).toEqual([]);
  });

  it("i18n parity (alias namespace)", () => {
    const k = (o: Record<string, string>) => Object.keys(o).sort();
    expect(k(ALIAS_EXTRA.zh)).toEqual(k(ALIAS_EXTRA.en));
  });
});

// --------------------------------------------------------------------------- card chip

describe("card chip", () => {
  const html = (a: AgentState, caps: unknown) => {
    const w = mount(AgentCard, {
      props: { card: toAgentCardView(a, (k) => k), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubOf([a], caps) } },
    });
    const out = w.html();
    w.unmount();
    return out;
  };
  it("@alias chip sits before the channel chip, truncated at 8 graphemes, title carries full", () => {
    const h = html(ag("a", { joined: true, channels: ["default", "x"], alias: "前端开发工作台一二三四" }), CAPS);
    expect(h).toContain("chip-xs-alias");
    expect(h.indexOf("chip-xs-alias")).toBeLessThan(h.indexOf("chip-xs-channels"));
    expect(h).toContain("@前端开发工作台一…");
    expect(h).toContain('title="@前端开发工作台一二三四"');
  });
  it("no cap or no field ⇒ no alias chip (byte-identical surface)", () => {
    expect(html(ag("a", { joined: true, alias: "web" }), ["xs.v1", "xs.channel.v1"])).not.toContain("chip-xs-alias");
    expect(html(ag("a", { joined: true }), CAPS)).not.toContain("chip-xs-alias");
  });
});

// --------------------------------------------------------------------------- detail header

describe("detail header @alias", () => {
  const mountHeader = (a: AgentState, caps: unknown) => {
    const hub = hubOf([a], caps);
    const view = {
      agentKey: a.key,
      control: {} as ControlHandle,
      enabled: computed(() => true),
      readonlyReason: computed(() => null),
      agent: computed(() => a),
      busy: computed(() => false),
      commands: computed(() => []),
      commandsEnabled: computed(() => true),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    } as ControlView;
    const w = mount(DetailHeader, {
      props: { agent: a, narrow: false },
      attachTo: document.body,
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(w);
    return w;
  };

  it("shows @alias after the title and opens the 「频道与别名」 dialog on click", async () => {
    const w = mountHeader(ag("a", { joined: true, alias: "前端" }), CAPS);
    const btn = w.find(".detail-alias-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe("@前端");
    await btn.trigger("click");
    await flushPromises();
    const body = new DOMWrapper(document.body);
    expect(body.text()).toContain("Channels & alias");
    expect(body.find(".alias-section").exists()).toBe(true);
  });

  it("absent without cap or without a held alias", () => {
    expect(
      mountHeader(ag("a", { joined: true, alias: "web" }), ["xs.v1"])
        .find(".detail-alias-btn")
        .exists(),
    ).toBe(false);
    expect(
      mountHeader(ag("a", { joined: true }), CAPS)
        .find(".detail-alias-btn")
        .exists(),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------- @ panel

describe("@ panel alias", () => {
  it("targets carry alias (cap-gated); filter matches alias prefix", () => {
    const self = ag("s", { joined: true });
    const b = ag("b", { joined: true, alias: "前端" });
    const m = new Map([
      ["s", self],
      ["b", b],
    ]);
    const withCap = sessionMentionTargets(m, CAPS, "s", (k) => k);
    expect(withCap[0]!.alias).toBe("前端");
    const noCap = sessionMentionTargets(m, ["xs.v1", "xs.channel.v1"], "s", (k) => k);
    expect(noCap[0]!.alias).toBeUndefined();
    expect(filterSessionTargets(withCap, "前端")).toHaveLength(1);
    expect(filterSessionTargets(withCap, "前")).toHaveLength(1);
    expect(filterSessionTargets(withCap, "nomatch")).toHaveLength(0);
  });

  it("Composer shows `@alias · name` but still inserts `session:<ref>`", async () => {
    const self = ag("me", { joined: true }, "aaaaaaaaaaaa0000");
    const b = ag("b", { joined: true, alias: "前端" }, "bbbbbbbbbbbb1111-2222", { name: "alpha" });
    const map = new Map([
      ["me", self],
      ["b", b],
    ]);
    const view = {
      agentKey: "me",
      control: null,
      enabled: computed(() => true),
      readonlyReason: computed(() => null),
      agent: computed(() => self),
      busy: computed(() => false),
      commands: computed(() => []),
      commandsEnabled: computed(() => false),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    } as unknown as ControlView;
    const hub = { state: ref({ agents: map, hub: { caps: CAPS } }) };
    const drafts = new Map<string, string>();
    const fakeCtl = {
      draft: (k: string) => drafts.get(k) ?? "",
      setDraft: (k: string, t: string) => void drafts.set(k, t),
    } as unknown as ControlHandle;
    const ctx = { agentKey: "me", control: fakeCtl, enabled: true };
    const w = mount(Composer, {
      props: { enabled: true, busy: false },
      attachTo: document.body,
      global: {
        provide: { [CONTROL_VIEW as symbol]: view, [CONTROL_CTX as symbol]: ctx, [HUB_CTX as symbol]: hub },
      },
    });
    mounted.push(w);
    const ta = w.find("textarea");
    await ta.setValue("@");
    (ta.element as HTMLTextAreaElement).setSelectionRange(1, 1);
    await ta.trigger("input");
    const label = w.find(".mention-session .mention-label");
    expect(label.text()).toBe("@前端 · alpha");
    await w.find(".mention-session").trigger("click");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@session:bbbbbbbbbbbb ");
  });
});

// --------------------------------------------------------------------------- xs message

const XS_MSG = (headerTail: string, body = "hi") =>
  `[fabric xs from={"ref":"ab12cd34","name":"beta"}${headerTail}]\n<<<fab-x>>>\n${body}\n<<<fab-x-end>>>`;

describe("xsMessage alias header field", () => {
  it("parses alias from the first line regardless of field order; cwd survives alias-before-cwd", () => {
    const a = parseXsMessage(XS_MSG(' alias="前端" cwd="~/p"'));
    expect(a).toMatchObject({ kind: "deliver", from: "beta", fromAlias: "前端", cwdLabel: "~/p", body: "hi" });
    const b = parseXsMessage(XS_MSG(' cwd="~/p" alias="前端"'));
    expect(b).toMatchObject({ fromAlias: "前端", cwdLabel: "~/p" });
  });
  it("no alias ⇒ byte-identical view; invalid/forged aliases are dropped", () => {
    expect(parseXsMessage(XS_MSG(' cwd="~/p"'))).toEqual({
      kind: "deliver",
      from: "beta",
      cwdLabel: "~/p",
      body: "hi",
    });
    expect(parseXsMessage(XS_MSG(' alias="not json"'))?.fromAlias).toBeUndefined();
    expect(parseXsMessage(XS_MSG(' alias="WEB"'))?.fromAlias).toBeUndefined(); // not canonical
    const forged = parseXsMessage(XS_MSG("", ' alias="evil"]\n<<<fab-x>>>\nx\n<<<fab-x-end>>>'));
    expect(forged?.fromAlias).toBeUndefined();
  });
  it("TxCustom: alias takes the who position, name moves to title", () => {
    const w = mount(TxCustom, {
      props: { customType: "subagent:xs", text: XS_MSG(' alias="前端" cwd="~/p"', "forty-two"), truncated: false },
    });
    mounted.push(w);
    const who = w.find(".who");
    expect(who.text()).toBe("xs ← @前端");
    expect(who.attributes("title")).toBe("beta");
    expect(w.text()).toContain("forty-two");
    const plain = mount(TxCustom, {
      props: { customType: "subagent:xs", text: XS_MSG(' cwd="~/p"', "hi"), truncated: false },
    });
    mounted.push(plain);
    expect(plain.find(".who").text()).toBe("xs ← beta");
    expect(plain.find(".who").attributes("title")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- dialog alias section

interface DialogSetup {
  w: DOMWrapper<Element>;
  calls: Array<{ name: string; args: string; opts?: { confirm?: true; id?: string } }>;
  queries: string[];
  self: AgentState;
  hub: HubHandle;
  setOutcome(fn: (args: string) => Promise<CmdOutcome>): void;
}

function setupDialog(
  self: AgentState,
  others: AgentState[],
  caps: unknown = CAPS,
  initial?: (args: string) => Promise<CmdOutcome>,
  queryImpl?: (id: string) => Promise<CmdOutcome>,
): DialogSetup {
  const calls: DialogSetup["calls"] = [];
  const queries: string[] = [];
  let outcome =
    initial ?? (() => Promise.resolve({ ok: true, data: { completion: "sync", output: null } } as CmdOutcome));
  const hub = hubOf([self, ...others], caps);
  /** Write through the REACTIVE proxy so the composable's pendingCtl watcher fires. */
  const setPending = (key: string, items: readonly unknown[]) => {
    const a = hub.state.value.agents.get(key) as unknown as { pendingCtl?: readonly unknown[] } | undefined;
    if (a !== undefined) a.pendingCtl = items;
  };
  const control = {
    runCommand: (k: string, name: string, args: string, opts?: { confirm?: true; id?: string }) => {
      calls.push({ name, args, ...(opts === undefined ? {} : { opts }) });
      // the real control dispatches ctl_send synchronously: the optimistic item lands NOW
      setPending(k, [{ id: opts?.id, kind: "command", name, state: "sending" }]);
      return outcome(args).then((o) => {
        // a terminal outcome settles the optimistic item (the reducer does this); an
        // async/unknown completion leaves it for the pendingCtl watcher to track
        const completion = o.ok ? (o.data as { completion?: unknown } | undefined)?.completion : undefined;
        if (!o.ok || (completion !== "async" && completion !== "unknown")) setPending(k, []);
        return o;
      });
    },
    query: (k: string, id: string) => {
      queries.push(id);
      return (queryImpl ?? (() => Promise.resolve({ ok: false, error: "E_UNKNOWN_ID" } as CmdOutcome)))(id);
    },
  } as unknown as ControlHandle;
  const view: ControlView = {
    agentKey: self.key,
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => hub.state.value.agents.get(self.key)!),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => true),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  const w = mount(ChannelsDialog, {
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    attachTo: document.body,
  });
  mounted.push(w);
  return {
    w: new DOMWrapper(document.body),
    calls,
    queries,
    self,
    hub,
    setOutcome(fn) {
      outcome = fn;
    },
  };
}

const syncEcho = (text: string) => () =>
  Promise.resolve({
    ok: true,
    data: { completion: "sync", captured: true, output: { entries: [{ kind: "text", text }] } },
  } as CmdOutcome);

describe("ChannelsDialog alias section", () => {
  it("no alias cap ⇒ byte-identical: old title, no alias section", () => {
    const { w } = setupDialog(ag("s", { joined: true }), [], ["xs.v1", "xs.channel.v1"]);
    expect(w.find(".channels-title").text()).toBe("Cross-session channels");
    expect(w.find(".alias-section").exists()).toBe(false);
  });

  it("with cap: title switches, section renders, current alias shown", () => {
    const { w } = setupDialog(ag("s", { joined: true, alias: "前端" }), []);
    expect(w.find(".channels-title").text()).toBe("Channels & alias");
    expect(w.find(".alias-section").exists()).toBe(true);
    expect(w.text()).toContain("Current: @前端");
    expect(w.find(".alias-actions").text()).toContain("Clear");
  });

  it("live validation hints via normalizeAlias (invalid / reserved / id_like / too_long)", async () => {
    const { w } = setupDialog(ag("s", { joined: true }), []);
    const input = w.get("input[name=alias-name]");
    await input.setValue("Bad Name");
    expect(w.get("#alias-hint").text()).toContain("letters");
    await input.setValue("system");
    expect(w.get("#alias-hint").text()).toContain("reserved");
    await input.setValue("deadbeef");
    expect(w.get("#alias-hint").text()).toContain("session id");
    await input.setValue("前端开发工作台一个超级长名字呀呀呀"); // 18 graphemes > 16
    expect(w.get("#alias-hint").text()).toContain("Too long");
    await input.setValue("web");
    expect(w.find("#alias-hint").exists()).toBe(false);
  });

  it("suggestion chips: cwd/name derived, taken marked but clickable (fills input only)", async () => {
    const self = ag("s", { joined: true }, "s-0123456789abcdef", { cwd: "/home/u/shop-front", name: "web-hub 重构" });
    const other = ag("o", { joined: true, alias: "shop-front" });
    const { w, calls } = setupDialog(self, [other]);
    const chips = w.findAll(".alias-sugg");
    expect(chips.map((c) => c.text())).toEqual(["@shop-front", "@web-hub"]);
    expect(chips[0]!.attributes("data-taken")).toBe("true");
    expect(chips[0]!.attributes("title")).toContain("taken");
    await chips[0]!.trigger("click");
    expect((w.get("input[name=alias-name]").element as HTMLInputElement).value).toBe("shop-front");
    expect(calls).toHaveLength(0); // never auto-submits
  });

  it("save: sends /fabric alias <a> with an own cmdId, shows the captured echo", async () => {
    const { w, calls } = setupDialog(ag("s", { joined: true }), [], CAPS, syncEcho("别名已设置：@web"));
    await w.get("input[name=alias-name]").setValue("Web");
    await w.get("form.alias-new").trigger("submit");
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("fabric");
    expect(calls[0]!.args).toBe("alias web"); // canonical (lowercased) form
    expect(typeof calls[0]!.opts?.id).toBe("string");
    expect(w.get(".alias-output").text()).toBe("别名已设置：@web");
  });

  it("clear: only with a held alias; failure surfaces the error text", async () => {
    const { w, calls } = setupDialog(ag("s", { joined: true, alias: "web" }), [], CAPS, () =>
      Promise.resolve({ ok: false, error: "E_XS_ALIAS_BUSY", message: "queue full" } as CmdOutcome),
    );
    const clearBtn = w.findAll(".alias-actions button").find((b) => b.text() === "Clear")!;
    await clearBtn.trigger("click");
    await flushPromises();
    expect(calls[0]!.args).toBe("alias --clear");
    expect(w.text()).toContain("Failed: queue full");
  });

  it("take flow: preview echo → token parsed from THIS output only → confirm box → --take=<token>", async () => {
    const preview = `别名「web」当前由其他会话持有。\n持有会话：~/ai/foo，已离线 3 天 4 小时。\n${formatTakeConfirmLine("web", TOKEN)}`;
    const { w, calls, setOutcome } = setupDialog(
      ag("s", { joined: true }),
      [],
      CAPS,
      // a save first: its output carries a confirm line with a DIFFERENT token — it must NOT
      // open the take box nor become the token source (only a take preview's own output counts)
      syncEcho(`干扰：别的命令输出里也有一行\n${formatTakeConfirmLine("web", "kffffffffffffffff")}`),
    );
    await w.get("input[name=alias-name]").setValue("web");
    await w.get("form.alias-new").trigger("submit");
    await flushPromises();
    expect(w.find(".alias-take-confirm").exists()).toBe(false);

    setOutcome(syncEcho(preview));
    const takeBtn = w.findAll(".alias-actions button").find((b) => b.text() === "Try take")!;
    await takeBtn.trigger("click");
    await flushPromises();
    expect(calls[1]!.args).toBe("alias web --take");
    const box = w.get(".alias-take-confirm");
    expect(box.get(".alias-take-preview").text()).toBe(preview); // holder cwd + offline duration
    expect(box.text()).toContain("token expires in");

    setOutcome(syncEcho("别名已设置为：@web"));
    await box.get(".alias-take-run").trigger("click");
    await flushPromises();
    expect(calls[2]!.args).toBe(`alias web --take=${TOKEN}`);
    expect(calls[2]!.opts?.id).not.toBe(calls[1]!.opts?.id);
    expect(w.find(".alias-take-confirm").exists()).toBe(false);
    expect(w.get(".alias-output").text()).toBe("别名已设置为：@web");
  });

  it("take preview without a confirm line (holder online) shows the echo, never a box", async () => {
    const { w, calls } = setupDialog(
      ag("s", { joined: true }),
      [],
      CAPS,
      syncEcho("别名「web」的持有者仍在线，不能抢占。"),
    );
    await w.get("input[name=alias-name]").setValue("web");
    await w
      .findAll(".alias-actions button")
      .find((b) => b.text() === "Try take")!
      .trigger("click");
    await flushPromises();
    expect(calls[0]!.args).toBe("alias web --take");
    expect(w.find(".alias-take-confirm").exists()).toBe(false);
    expect(w.get(".alias-output").text()).toContain("仍在线");
  });

  it("expired token (5 min): confirm disabled, re-preview hint", async () => {
    vi.useFakeTimers();
    const preview = `持有会话：~/ai/foo，已离线 1 小时。\n${formatTakeConfirmLine("web", TOKEN)}`;
    const { w } = setupDialog(ag("s", { joined: true }), [], CAPS, syncEcho(preview));
    await w.get("input[name=alias-name]").setValue("web");
    await w
      .findAll(".alias-actions button")
      .find((b) => b.text() === "Try take")!
      .trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    const run = () => w.get(".alias-take-confirm .alias-take-run");
    expect(run().attributes("disabled")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
    expect(run().attributes("disabled")).toBeDefined();
    expect(w.get(".alias-take-confirm").text()).toContain("Expired");
  });

  it("policy confirm (webCommandPolicy.fabric=confirm): generic bar, resend with NEW id + confirm", async () => {
    let n = 0;
    const { w, calls } = setupDialog(ag("s", { joined: true }), [], CAPS, () => {
      n++;
      return n === 1
        ? Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED", message: "confirm /fabric" } as CmdOutcome)
        : Promise.resolve({
            ok: true,
            data: { completion: "sync", captured: true, output: { entries: [{ kind: "text", text: "OK" }] } },
          } as CmdOutcome);
    });
    await w.get("input[name=alias-name]").setValue("web");
    await w.get("form.alias-new").trigger("submit");
    await flushPromises();
    const bar = w.get(".command-confirm");
    expect(bar.text()).toContain("/fabric alias web");
    await bar.get(".command-confirm-run").trigger("click");
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts?.confirm).toBe(true);
    expect(calls[1]!.opts?.id).not.toBe(calls[0]!.opts?.id);
    expect(w.get(".alias-output").text()).toBe("OK");
  });

  it("async settle: pendingCtl item gone ⇒ one queryOnly, echo unwrapped from result.data.output", async () => {
    const self = ag("s", { joined: true });
    const { w, hub, queries } = setupDialog(
      self,
      [],
      CAPS,
      () => Promise.resolve({ ok: true, data: { completion: "async", captured: true } } as CmdOutcome),
      () =>
        Promise.resolve({
          ok: true,
          data: {
            result: { ok: true, data: { captured: true, output: { entries: [{ kind: "text", text: "ASYNC-ECHO" }] } } },
          },
        } as CmdOutcome),
    );
    await w.get("input[name=alias-name]").setValue("web");
    await w.get("form.alias-new").trigger("submit");
    await flushPromises();
    // async: the dialog keeps waiting on the tracked item — no echo, no query yet
    expect(w.find(".alias-output").exists()).toBe(false);
    expect(w.text()).toContain("Applying");
    expect(queries).toHaveLength(0);
    // cmd_late settles the item ⇒ exactly one queryOnly brings the captured echo
    (hub.state.value.agents.get("s") as unknown as { pendingCtl: unknown[] }).pendingCtl = [];
    await flushPromises();
    expect(queries).toHaveLength(1);
    expect(w.get(".alias-output").text()).toBe("ASYNC-ECHO");
  });

  it("closing the dialog mid-flight cancels tracking (a late settle is dropped)", async () => {
    const self = ag("s", { joined: true });
    const { w, hub, queries } = setupDialog(self, [], CAPS, () =>
      Promise.resolve({ ok: true, data: { completion: "async", captured: true } } as CmdOutcome),
    );
    await w.get("input[name=alias-name]").setValue("web");
    await w.get("form.alias-new").trigger("submit");
    await flushPromises();
    for (const m of mounted.splice(0)) m.unmount(); // dialog closed
    (hub.state.value.agents.get("s") as unknown as { pendingCtl: unknown[] }).pendingCtl = [];
    await flushPromises();
    expect(queries).toHaveLength(0);
  });
});
