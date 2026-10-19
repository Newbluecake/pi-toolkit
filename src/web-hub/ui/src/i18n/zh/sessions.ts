import en from "../en/sessions.js";

type Messages<T> = { [K in keyof T]: string };

/** LAN security r2 §3.2 (package D): 「登录会话」设置卡片中文文案，键位与 en/sessions.ts 一一对应。 */
const sessions = {
  title: "登录会话",
  hint: "当前 LAN 上的登录设备。会话闲置 {idle} 分钟或登录满 {days} 天后自动失效。",
  currentDevice: "本设备",
  unknownDevice: "未知设备",
  colIp: "IP",
  colLogin: "登录时间",
  colActive: "最近活跃",
  justNow: "刚刚",
  minutesAgo: "{n} 分钟前",
  hoursAgo: "{n} 小时前",
  daysAgo: "{n} 天前",
  revoke: "下线",
  revokeOthers: "下线其他所有设备",
  revokeOthersArmed: "再次点击确认",
  revokedOk: "已退出 {n} 台设备",
  revokedPartial: "已退出 {n} 台设备；部分会话未能下线，请重试",
  capNote: "最多显示 {max} 台设备。下线立即生效，对端下次请求时需重新登录。",
  loading: "加载中…",
  errorLoad: "会话列表加载失败。",
  errorRevoke: "下线操作失败。",
  retry: "重试",
  refresh: "刷新",
} satisfies Messages<typeof en>;

export default sessions;
