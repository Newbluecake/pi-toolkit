/**
 * traffic 共享类型与常量（T2a：模块无可变状态；运行时状态全部归 engine，见 engine.ts）。
 * T2b：PendingRequest / Attempt / GateSlot 随闸门与推断关联层退役（归属见 ticket.ts）。
 * 数据库路径算法见 db.ts 的 defaultRecordPaths()（#54：跟随 PI_CODING_AGENT_DIR，带 H 继承回退；未设变量时等于 homedir()/.pi/agent/records）。
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export const BASE_PORT = 4177;
export const MAX_PORT_TRIES = 20;
/** server 绑定地址：默认绑全网口，支持局域网访问（T4 改为 traffic.web.host，默认 127.0.0.1）。 */
export const BIND_HOST = "0.0.0.0";

export type { IncomingMessage, Server, ServerResponse };
