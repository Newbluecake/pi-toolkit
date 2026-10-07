/**
 * Every component's Props/Emits interface (vue-plan.md v2.1 §3.2, §5.2 — P0 frozen). P3/P4
 * build the actual `.vue` files (their own exclusive new files, plan §5.2) against these —
 * `defineProps<XxxProps>()` / `defineEmits<XxxEmits>()` referencing them directly, so a
 * signature drift between a component and whatever calls it is a `vue-tsc` compile error, not
 * a runtime surprise. Components with no emits only get a `*Props` interface.
 */
import type { AgentCard, HistoryPayload } from "@protocol/http-contract.js";
import type { FleetRowWire, SessionInfo as WireSessionInfo } from "@protocol/messages.js";
import type { IconName } from "./icons/names.js";
import type {
  AgentCardView,
  AgentState,
  ConnState,
  FleetOmittedWire,
  FleetTreeNode,
  HubHandle,
  LoginErrorView,
  Notice,
  Route,
  RunVisualState,
  ToolView,
} from "./types.js";

// Re-exported so a component only needs `import type { HistoryPayload } from "../contracts.js"`
// alongside its own Props/Emits — never a second, possibly-drifting import path for the same type.
export type { HistoryPayload };

// ---------------------------------------------------------------------------
// shell/
// ---------------------------------------------------------------------------

export interface LoginViewProps {
  readonly plaintext: boolean;
  readonly busy: boolean;
  readonly error: LoginErrorView | null;
  readonly initialPasswordHint: boolean;
}
export interface LoginViewEmits {
  submit: [payload: { username: string; password: string }];
}

export interface TokenGateProps {
  readonly reason: "token-invalid" | "auth-mode-unknown";
}

export interface DashboardViewProps {
  readonly hub: HubHandle;
  readonly route: Route;
}

export interface TopBarProps {
  readonly conn: ConnState;
  readonly hubVersion: string | null;
  readonly canSignOut: boolean;
}
export interface TopBarEmits {
  signout: [];
}

export interface NoticeStackProps {
  readonly notices: readonly Notice[];
}
export interface NoticeStackEmits {
  action: [id: string];
}

export interface NoticeBannerProps {
  readonly notice: Notice;
  readonly compact?: boolean;
}
export interface NoticeBannerEmits {
  action: [id: string];
}

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
}

// ---------------------------------------------------------------------------
// agents/
// ---------------------------------------------------------------------------

export interface AgentListProps {
  readonly cards: readonly AgentCardView[];
  readonly selectedKey: string | null;
  readonly filter: string;
}
export interface AgentListEmits {
  "update:filter": [value: string];
}

export interface AgentCardProps {
  readonly card: AgentCardView;
  readonly selected: boolean;
}

// ---------------------------------------------------------------------------
// detail/
// ---------------------------------------------------------------------------

export interface AgentDetailProps {
  readonly agent: AgentState;
  readonly now: number;
  readonly narrow: boolean;
}
export interface AgentDetailEmits {
  back: [];
  retry: [];
  "load-older": [];
}

export interface DetailHeaderProps {
  readonly agent: AgentState;
  readonly narrow: boolean;
}
export interface DetailHeaderEmits {
  back: [];
}

export interface SessionInfoProps {
  readonly session: WireSessionInfo | undefined;
  readonly card: AgentCard | undefined;
  /** 2026-10-07 user request (「花费合并到第一行的会话详情」): the header's separate cost row
   * folded into this component — the summary line gains a cost chip, the expanded kv panel
   * gains the cost row (incl. the sub-agent aside). Absent/undefined ⇒ neither renders. */
  readonly costUsd?: number | undefined;
  readonly subagentCostUsd?: number | undefined;
}

export interface CopyButtonProps {
  readonly value: string;
  readonly label: string;
}

export interface ContextMeterProps {
  readonly percent: number | null;
  readonly tokens?: number;
  readonly window?: number;
  readonly compact?: boolean;
}

export interface StatusPillProps {
  readonly state: RunVisualState;
  readonly label: string;
}

export interface ComposerProps {
  readonly enabled: boolean;
  readonly draft?: string;
  readonly busy?: boolean;
}
export interface ComposerEmits {
  send: [text: string, deliver: "steer" | "followUp"];
}
export interface StopButtonProps {
  readonly busy: boolean;
  readonly queueCount?: number;
}
export interface StopButtonEmits {
  stop: [];
}
/** Merged ring+stop control (2026-10 user request): `busy`/`queueCount`/`stop` only matter
 * while the agent is busy — idle renders the plain context ring, no stop affordance. */
export interface ContextRingProps {
  readonly busy?: boolean;
  readonly queueCount?: number;
}
export interface ContextRingEmits {
  stop: [];
}
export interface QueueListProps {
  readonly items: readonly unknown[];
}
export interface QueueListEmits {
  retry: [id: string];
  discard: [id: string];
}
export interface ControlNoticeProps {
  readonly plaintext?: boolean;
  readonly mode?: "token" | "password";
}
export interface AskUserFormProps {
  readonly dialog: unknown;
  readonly suspended?: boolean;
}
export interface AskUserFormEmits {
  answer: [answers: unknown];
  cancel: [];
}
export interface AskUserQuestionProps {
  readonly question: unknown;
}
export interface FleetActionsProps {
  readonly agentKey: string;
  readonly runId: string;
  readonly enabled: boolean;
}
export interface DetailDockProps {
  readonly following: boolean;
  readonly newCount: number;
  readonly control?: import("./types.js").ControlHandle;
  readonly queue?: readonly unknown[];
  readonly busy?: boolean;
  readonly readonlyReason?: string;
}
export interface DetailDockEmits {
  "update:following": [value: boolean];
  jump: [];
}

// ---------------------------------------------------------------------------
// body/DetailBody.vue — the P0→P4 seam (plan §1.1, §3.2)
// ---------------------------------------------------------------------------

export interface DetailBodyProps {
  readonly agent: AgentState;
  readonly now: number;
  readonly following: boolean;
  readonly narrow: boolean;
  /** fleet-drawer §6.3 (F6): 抽屉开合状态,透给 FleetSummaryBar 的 `aria-expanded`。 */
  readonly drawerOpen?: boolean;
}
export interface DetailBodyEmits {
  "load-older": [];
  "update:following": [value: boolean];
  "new-count": [n: number];
  /** fleet-drawer §6.3 (F6): FleetSummaryBar 的开关点击。 */
  "toggle-drawer": [];
}

// ---------------------------------------------------------------------------
// fleet/ + drawer/ (P4; fleet-drawer plan v2 §6.3 — F6 对 P0 冻结面的有意修订:
// FleetPanelProps/FleetNodeProps 随浮层机制一起删除,换成抽屉时代的四组契约。)
// ---------------------------------------------------------------------------

/** fleet-drawer §6.2 的三种抽屉模式(视觉由 CSS 按 `.detail[data-drawer=…]` 决定,行为由 JS 决定)。 */
export type FleetDrawerMode = "docked" | "overlay" | "fullscreen";

export interface FleetSummaryBarProps {
  readonly rows: readonly FleetRowWire[];
  /** 抽屉当前是否打开(仅驱动 `aria-expanded`;docked+open 时整条由 CSS 隐藏)。 */
  readonly open: boolean;
}
export interface FleetSummaryBarEmits {
  toggle: [];
}

export interface FleetTreeProps {
  readonly nodes: readonly FleetTreeNode[];
  readonly now: number;
  /** 递归层级(根为 0;≥3 层的子树默认折叠,「另有 N 个」只在根层级渲染)。 */
  readonly depth?: number;
  /** §6.3 孤儿行:父 run 不在投影行内的 runId 集合(它们被提升为根,加「父 run 未列出」chip)。 */
  readonly orphans?: ReadonlySet<string>;
  /** §3.2/#12: fleet 帧的 omitted 计数(仅根层级消费;`undefined` 显式允许 ——
   *  `exactOptionalPropertyTypes` 下模板绑定的 `agent.fleetOmitted` 可能为 undefined)。 */
  readonly omitted?: FleetOmittedWire | undefined;
}

export interface FleetDrawerProps {
  readonly agent: AgentState;
  readonly now: number;
  readonly mode: FleetDrawerMode;
  readonly open: boolean;
}
export interface FleetDrawerEmits {
  close: [];
}

export interface RunHeaderProps {
  readonly agent: AgentState;
  readonly mode: FleetDrawerMode;
}
export interface RunHeaderEmits {
  back: [];
  close: [];
}

export interface RunTranscriptProps {
  readonly agent: AgentState;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// transcript/ (P4)
// ---------------------------------------------------------------------------

/**
 * fleet-drawer plan §6.6 (F6): `Transcript.vue` 的渲染内核只吃这 8 个字段 —— 主会话传整个
 * `AgentState`(结构上兼容),抽屉传 `RunTxState` 的投影。F5 已保证两者的 items/streaming/
 * tools/history 四态同构,`buildTxEntries`/`indexTools` 随之同步收窄。
 */
export type TranscriptSource = Pick<
  AgentState,
  "key" | "items" | "streaming" | "tools" | "history" | "historyError" | "hasMore" | "paging"
>;

export interface TranscriptProps {
  readonly agent: TranscriptSource;
  readonly following: boolean;
  readonly narrow: boolean;
  /** §6.6: 根节点的 DOM id(锚点/焦点回退目标)。主会话用默认的 `"transcript"`,抽屉里
   * 传 `"run-transcript"`,保证两个 Transcript 并存时 id 不重复(U7)。 */
  readonly anchorId?: string;
  /** 覆盖 `transcript.ariaLabel` 的地标名(抽屉里用 `drawer.runTranscriptAria`)。 */
  readonly ariaLabel?: string;
  /** session-switch plan §1.4 (E1-6): 滚动位置记忆的 opt-in key —— 只有主会话的
   * DetailBody 传 `agent.key`;抽屉 RunTranscript 不传 ⇒ 不读写滚动记忆(天然隔离)。 */
  readonly memoryKey?: string;
}
export interface TranscriptEmits {
  "load-older": [];
  "update:following": [value: boolean];
  "new-count": [n: number];
}

export interface ToolCardProps {
  readonly view: ToolView;
}

export interface CodeBlockProps {
  readonly lang: string;
  readonly text: string;
}

export interface MarkdownViewProps {
  readonly text: string;
}
