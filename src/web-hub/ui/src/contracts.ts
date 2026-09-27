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
  FleetTreeNode,
  HubHandle,
  LoginErrorView,
  Notice,
  Route,
  RunVisualState,
  ThemePref,
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
  readonly theme: ThemePref;
}
export interface TopBarEmits {
  signout: [];
  "update:theme": [value: ThemePref];
}

export interface ThemeToggleProps {
  readonly modelValue: ThemePref;
}
export interface ThemeToggleEmits {
  "update:modelValue": [value: ThemePref];
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

export interface DetailDockProps {
  readonly following: boolean;
  readonly newCount: number;
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
}
export interface DetailBodyEmits {
  "load-older": [];
  "update:following": [value: boolean];
  "new-count": [n: number];
}

// ---------------------------------------------------------------------------
// fleet/ (P4)
// ---------------------------------------------------------------------------

export interface FleetPanelProps {
  readonly rows: readonly FleetRowWire[];
  readonly now: number;
  readonly defaultOpen: boolean;
}

export interface FleetNodeProps {
  readonly node: FleetTreeNode;
  readonly depth: number;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// transcript/ (P4)
// ---------------------------------------------------------------------------

export interface TranscriptProps {
  readonly agent: AgentState;
  readonly following: boolean;
  readonly narrow: boolean;
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
