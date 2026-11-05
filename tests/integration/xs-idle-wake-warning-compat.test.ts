import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { XsSendOutcome } from "../../src/fabric/xs/sender.js";
import { XS_IDLE_NO_WAKE_HINT, xsIdleNoWakeRisk } from "../../src/tools/message-session-tool.js";
import { XsHarness, list, until } from "./helpers/fabric-xs-harness.js";

let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 30_000);

/** Frozen pre-#20 rendering copy: no calls to production hint functions. */
function renderPre20(o: XsSendOutcome, reply = true, alias = true, activation = true): string {
  let hint = "";
  if (reply) {
    if (o.reply?.state === "pending")
      hint += `\n已登记期待回复 ${o.reply.requestId}，截止 ${o.reply.dueAt}；回复到达或超时都会通知你，无需轮询（pi 重启会使未决请求失效）。`;
    if (o.replyTo !== undefined) {
      if (o.effect === "unknown")
        hint +=
          "\n可能已送达。对方凭证一次性：重发同一回复不会造成重复投递，但可能被拒收（拒收说明对方已收到、已超过宽限期，或对方 pi 已重启使凭证失效）。";
      else if (o.effect === "none" && o.reason === "rejected")
        hint += "\n对方未接收（已收到过回复、凭证过期或失效、或对方策略拒收）；不要再重发。";
    } else if (o.effect === "unknown")
      hint += "\n注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";
  } else if (o.effect === "unknown")
    hint = "\n注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";
  if (alias && o.status === "alias_unavailable") hint += "\nhub 别名服务暂不可用，请用 list_sessions 给出的 ref";
  if (activation && o.wakeDowngraded) {
    const quota = o.wakeDowngraded === "pair_wake_rate" ? "（hub，每会话对默认 2 次/小时）" : "";
    hint += `\n唤醒因 ${o.wakeDowngraded} 降级${quota}；${o.effect === "none" ? "正文未送达" : o.effect === "applied" ? "正文投递已确认，非 started 证明" : "正文可能已进入队列"}，不要重发。仅已确认送达且未开始的有效原 receipt 可人工 activate；配额降级须等待配额，unknown 只查询。`;
  }
  return JSON.stringify(o) + hint;
}

describe("#20 expectReply mixed-version content byte differential", () => {
  it.each(["old-target", "old-hub"] as const)(
    "%s × new requester remains pre20 byte-identical",
    async (topology) => {
      h = new XsHarness();
      await h.boot("hub", "hub", undefined, true, false, topology === "old-hub" ? { XW_HUB_STRIP_STATE: "1" } : {});
      const a = await h.boot("agent", "alpha");
      const b = await h.boot(
        "agent",
        "beta",
        undefined,
        true,
        false,
        topology === "old-target" ? { XW_STRIP_STATE: "1" } : {},
      );
      await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
      const bid = (await b.rpc("inspect")).sessionId as string;
      await until(
        () => list(a),
        (l) => l.rows?.some((r: { ref: string }) => bid.startsWith(r.ref)),
        "membership publish",
      );
      const result = await a.rpc<{ content: Array<{ type: string; text: string }>; details: XsSendOutcome }>(
        "toolContent",
        {
          name: "message_session",
          params: { to: bid, text: "PRE20-COMPAT-REQUEST", wake: false, expectReply: {} },
        },
      );
      expect(result.details).toMatchObject({ status: "sent", effect: "applied", reply: { state: "pending" } });
      expect(result.details.track).toBeUndefined();
      expect(result.details.progress).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: renderPre20(result.details) }]);
      expect(result.content[0]!.text).not.toContain(XS_IDLE_NO_WAKE_HINT);
      expect(
        (await b.rpc("inspect")).messages.filter((m: { content: string }) =>
          m.content.includes("PRE20-COMPAT-REQUEST"),
        ),
      ).toHaveLength(1);
    },
    60_000,
  );
});

it("#20 real activate() freezes advice on wake setting: wake-off retains qualifying outcome but pre20 content", async () => {
  h = new XsHarness();
  await h.boot("hub");
  const a = await h.boot("agent", "alpha");
  const b = await h.boot("agent", "beta");
  await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
  const bid = (await b.rpc("inspect")).sessionId as string;
  await until(
    () => list(a),
    (l) => l.rows?.some((r: { ref: string }) => bid.startsWith(r.ref)),
    "membership publish",
  );
  // No new helper settings knob: modify this sandbox peer's existing settings, then reload it.
  const file = join(h.home, ".pi/agent", "pi-subagent.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings.fabric.wake.enabled = false;
  writeFileSync(file, JSON.stringify(settings));
  const on = await a.rpc<{ content: Array<{ type: string; text: string }>; details: XsSendOutcome }>("toolContent", {
    name: "message_session",
    params: { to: bid, text: "FROZEN-ON", wake: false, expectReply: {} },
  });
  expect(xsIdleNoWakeRisk(on.details)).toBe(true);
  expect(on.content).toEqual([{ type: "text", text: renderPre20(on.details) + "\n" + XS_IDLE_NO_WAKE_HINT }]);
  await a.rpc("reload");
  await until(
    () => a.rpc("inspect"),
    (s) => s.conn?.state === "live",
    "reload live",
  );
  await until(
    () => list(a),
    (l) => l.rows?.some((r: { ref: string }) => bid.startsWith(r.ref)),
    "reload membership",
  );
  await Promise.all(h.peers.map((peer) => peer.rpc("skew", { ms: 31_000 })));
  const off = await a.rpc<{ content: Array<{ type: string; text: string }>; details: XsSendOutcome }>("toolContent", {
    name: "message_session",
    params: { to: bid, text: "FROZEN-OFF", wake: false, expectReply: {} },
  });
  expect(off.details).toMatchObject({
    status: "sent",
    effect: "applied",
    reply: { state: "pending" },
    wake: { requested: false },
    track: { activationKey: expect.any(String) },
  });
  expect(xsIdleNoWakeRisk(off.details)).toBe(true);
  expect(off.content).toEqual([{ type: "text", text: renderPre20(off.details) }]);
}, 60_000);
