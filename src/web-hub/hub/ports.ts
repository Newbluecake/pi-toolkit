/**
 * hub internal ports (plan §包 A — frozen interface). Types only, no runtime
 * code: package B implements these (hub core + history), package C consumes
 * them (HTTP/SSE frontend) — this file is what lets B and C compile in
 * parallel against a frozen surface.
 */
import type { AgentCard, HistoryPayload } from "../protocol/http-contract.js";
import type { AgentId, FleetRowWire, SessionInfo, StatusInfo, WireEntry, WireEvent } from "../protocol/messages.js";
import type { HubPaths } from "../protocol/paths.js";
import type { PROTO } from "../protocol/version.js";

export interface HubConfig {
  v: 1;
  home: string;
  port: number;
  idleExitMinutes: number;
  pluginVersion: string;
  buildId: string;
  launcher?: [string, string];
}

export interface HubLog {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

export interface AgentView extends AgentCard {
  agentId: AgentId;
  connectedAt: number;
  lastFrameAt: number;
  seq: number;
}

export interface RegistryView {
  list(): readonly AgentView[];
  get(agentKey: string): AgentView | undefined;
}

export type HubEvent =
  | { type: "agent_up"; agent: AgentCard }
  | { type: "agent_down"; agentKey: string; reason: string }
  | { type: "agent_stale"; agentKey: string }
  | { type: "session"; agentKey: string; session: SessionInfo }
  | { type: "ev"; agentKey: string; seq: number; e: WireEvent }
  | { type: "status"; agentKey: string; status: StatusInfo }
  | { type: "fleet"; agentKey: string; runs: FleetRowWire[] }
  | { type: "prompt"; agentKey: string; prompts: AgentCard["prompts"] }
  | { type: "gap"; agentKey: string; fromSeq: number }
  | { type: "append"; agentKey: string; entries: WireEntry[] };

export interface HubBus {
  subscribe(fn: (e: HubEvent) => void): () => void;
}

export interface HistoryService {
  snapshot(agentKey: string): Promise<HistoryPayload>; // §7 步骤 1-4；deadline TIMING.snapshotMs → reject E_DEADLINE
  page(agentKey: string, beforeEntryId: string, limit: number): Promise<HistoryPayload>;
  onLeafChanged(agentKey: string, leafId: string | null): void; // status.leafId 变化时调用；有订阅者才工作，500ms 去抖；结果经 bus `append` 事件发出
}

export interface HubInfo {
  version: string;
  buildId: string;
  pid: number;
  startedAt: number;
  proto: typeof PROTO;
}

export interface FrontendDeps {
  config: HubConfig;
  paths: HubPaths;
  registry: RegistryView;
  bus: HubBus;
  history: HistoryService;
  log: HubLog;
  info: () => HubInfo;
  now: () => number;
}

export interface HttpFrontend {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  clientCount(): number;
}

export type FrontendFactory = (deps: FrontendDeps) => HttpFrontend;
