/**
 * `xs` namespace — the LAZY i18n for the cross-session request UI (fabric-xs-activation plan
 * §3 P4). Same posture as `alias-extra.ts` / `channels-extra.ts` / `resume-extra.ts`: NOT under
 * `en/`/`zh/` (the eager glob in `index.ts` would fold it into the first-screen bundle); the
 * components that render the request area / the received-card badge call `registerXsExtra()`
 * once. Parity: zh `Record<keyof typeof en, string>` pinned here.
 *
 * Language split (repo rule): compact markers stay English tokens (`queued`, `delivered`,
 * `wake↓ pair_wake_rate` — built in `logic/xsRequestState.ts`); only the prose evidence
 * notes / button labels / aria copy are translated.
 */
import { MESSAGES } from "./index.js";

const en = {
  areaAria: "Cross-session requests",
  rowAria: "Request {id}",
  noteQueued: "Queued at the target: the session was busy and the message was accepted into its queue.",
  noteDelivered: "Delivered: the message is confirmed written into the target session.",
  noteStarted: "Started: the target's model turn has read the message (an observation point — not a reply).",
  noteReplied: "Replied: the reply is confirmed written back into this session.",
  noteUnknown: "Unconfirmed transport: the outcome is unknown. Query read-only — do not resend the body.",
  noteNotDelivered: "Not delivered: the send was refused before delivery. Fix and send again as a NEW message.",
  noteUnavailable: "Tracking unavailable (hub restart or tracking full): evidence may be missing. Fail-closed.",
  noteOffline: "The target link is offline: phases are kept, but nothing new can be proven right now.",
  noteExpired: "The tracking window has expired: this request can no longer be queried or activated.",
  noteSeeded: "Local record — waiting for the session's first status report.",
  noteOmitted: "+{n} older request(s) hidden",
  retryAfterNote: "Quota not recovered yet — retry after {t}. Nothing runs automatically.",
  expiredKeyNote: "The activation window has expired; the original key is no longer valid.",
  activate: "Activate",
  activateAria: "Activate the target session on message {id} (original key — never resends the body)",
  activating: "Activating…",
  query: "Query",
  queryAria: "Read-only progress query for message {id}",
  cardTitleDowngraded: "Wake downgraded at {stage} ({reason}); the body was delivered as-is — do not resend.",
  cardTitleDispatch: "Wake accepted — waiting for the target to act.",
  cardTitleEnded: "The wake run ended ({ended}).",
  cardTitleUnknown: "The wake outcome is unknown.",
  cardTitlePhase: "Progress: {phase}.",
  mentionQueued: "Request sent to {label} — queued at the target.",
  mentionDelivered: "Delivered to {label}.",
  mentionPending: "Delivered to {label}; wake pending.",
  mentionStarted: "{label} has started processing the request.",
  mentionUnknown: "Sent to {label} — outcome unknown (query later; do not resend).",
  dismissAria: "Hide request {id} locally",
  dismissTitle: "Only hides this request locally; tracking and query/activate remain unchanged.",
} satisfies Record<string, string>;

const zh: Record<keyof typeof en, string> = {
  areaAria: "跨会话请求",
  rowAria: "请求 {id}",
  noteQueued: "已在对端排队：对方会话正忙，消息已受理入队。",
  noteDelivered: "已送达：消息已确认写入对方会话。",
  noteStarted: "已开始：对方模型回合已读到原消息（观察点，不代表已回复）。",
  noteReplied: "已回复：回复已确认写回本会话。",
  noteUnknown: "传输结果未知：只读查询即可，请勿重发正文。",
  noteNotDelivered: "未送达：发送在投递前被拒。修改后请作为新消息重新发送。",
  noteUnavailable: "跟踪不可用（hub 重启或跟踪已满）：证据可能缺失，按 fail-closed 处理。",
  noteOffline: "对端链路离线：已知阶段保留，暂无法证明新进展。",
  noteExpired: "跟踪窗口已过期：该请求已不能查询或激活。",
  noteSeeded: "本地记录——等待会话的首个状态上报。",
  noteOmitted: "另有 {n} 条较早请求未显示",
  retryAfterNote: "配额未恢复——{t} 后可再试。不会自动执行。",
  expiredKeyNote: "激活窗口已过期，原 key 不再有效。",
  activate: "激活",
  activateAria: "就消息 {id} 激活对方会话（复用原 key，绝不重发正文）",
  activating: "激活中…",
  query: "查询",
  queryAria: "只读查询消息 {id} 的进展",
  cardTitleDowngraded: "唤醒在 {stage} 被降级（{reason}）；正文已按原样投递，无需重发。",
  cardTitleDispatch: "唤醒已受理——等待对方执行。",
  cardTitleEnded: "唤醒执行已结束（{ended}）。",
  cardTitleUnknown: "唤醒结果未知。",
  cardTitlePhase: "进展：{phase}。",
  mentionQueued: "已向 {label} 发送请求——对方排队中。",
  mentionDelivered: "已送达 {label}。",
  mentionPending: "已送达 {label}，唤醒待执行。",
  mentionStarted: "{label} 已开始处理该请求。",
  mentionUnknown: "已向 {label} 发送，结果未知（稍后可查询，勿重发）。",
  dismissAria: "仅在本端隐藏请求 {id}",
  dismissTitle: "仅在本端隐藏，不删除跟踪记录，也不影响查询或激活。",
};

export const XS_EXTRA: Readonly<Record<"en" | "zh", Readonly<Record<string, string>>>> = { en, zh };

let registered = false;

/** Merge the lazy keys into `MESSAGES.<lang>.xs` (idempotent). */
export function registerXsExtra(): void {
  if (registered) return;
  registered = true;
  for (const lang of ["en", "zh"] as const) {
    const dict = MESSAGES[lang]["xs"];
    if (dict === undefined) MESSAGES[lang]["xs"] = { ...XS_EXTRA[lang] };
    else for (const [k, v] of Object.entries(XS_EXTRA[lang])) if (!(k in dict)) dict[k] = v;
  }
}
