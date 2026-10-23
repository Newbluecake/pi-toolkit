/**
 * Mermaid probe corpus (web-hub-mermaid plan §10.4). PURE DATA — imported both by the probe page
 * (`mermaid.ts`) and by the Node-side driver (`scripts/web-hub/csp-probe.ts --suite mermaid`),
 * so it must not import anything. Groups: R render, N network/DOM side effects, C effective config,
 * F fonts/measurement, M math, L limits.
 */

export type Expect =
  | { kind: "ok" }
  | { kind: "error"; reasons: string[] }
  /** Any outcome is acceptable (the case only asserts side-effect freedom). */
  | { kind: "any" };

export interface ProbeCase {
  id: string;
  group: "R" | "N" | "C" | "F" | "M" | "L";
  text: string;
  expect: Expect;
  /** Both themes are rendered for R cases by default. */
  themes?: Array<"light" | "dark">;
}

const ok: Expect = { kind: "ok" };
const err = (...reasons: string[]): Expect => ({ kind: "error", reasons });

export const USER_FLOW = `flowchart TB
  subgraph EDGE["接入层"]
    SDK["Python / TS SDK"]
    CLI["CLI / Web 控制台"]
    E2B["E2B 兼容 API<br/>（Harbor --env e2b、E2B SDK）"]
  end
  subgraph CP["控制面（Go · 全部无状态 · 多实例）"]
    API["API Gateway<br/>鉴权 · 路由 · 沙箱 ID 解码直达节点"]
    IAM["IAM<br/>多级项目 · 配额租约下放"]
    PL["Placement<br/>power-of-k + 本地在途视图"]
  end
  subgraph NODE["计算节点 × N（不可信侧）"]
    ND["node daemon（Rust）<br/>本地准入终审 · 生命周期 · 快照 · TTL"]
    STO["存储<br/>EROFS · overlaybd + ublk · 本地缓存"]
  end
  SDK --> API
  CLI --> API
  E2B --> API
  API --> IAM
  API --> PL
  PL ==>|调度/绑定| ND
  ND --> STO
  E2B -.SDK 透传.-> API`;

/** `edges` edges over 60 nodes (a compact graph: a vertical chain of 500 nodes exceeds MAX_SIDE_PX by design). */
const dense = (edges: number): string =>
  "flowchart LR\n" + Array.from({ length: edges }, (_, i) => `  n${i % 60} --> n${(i * 7 + 3) % 60}`).join("\n");

export const CORPUS: ProbeCase[] = [
  /* ------------------------------------------------------------------------------------- R */
  { id: "user-flow", group: "R", text: USER_FLOW, expect: ok },
  {
    id: "flow-graph-kw",
    group: "R",
    text: "graph LR\n  A[开始] --> B{判断}\n  B -- 是 --> C[结束]\n  B -- 否 --> A",
    expect: ok,
  },
  {
    id: "flow-dagre",
    group: "R",
    text: "---\nconfig:\n  layout: dagre\n---\nflowchart LR\n  A --> B --> C",
    expect: ok,
  },
  { id: "flow-elk-kw", group: "R", text: "flowchart-elk TD\n  A --> B\n  A --> C", expect: ok },
  {
    id: "sequence",
    group: "R",
    text: `sequenceDiagram
  autonumber
  participant U as 用户
  participant GW as API Gateway
  U->>GW: POST /sandboxes<br/>（E2B 兼容请求）
  Note over U,GW: 本地在途视图<br/>避免中心化锁
  GW-->>U: 201 Created`,
    expect: ok,
  },
  {
    id: "class",
    group: "R",
    text: "classDiagram\n  class Driver {\n    <<interface>>\n    +create(spec) Sandbox\n  }\n  class FirecrackerDriver {\n    +jailer 沙箱化\n  }\n  Driver <|.. FirecrackerDriver",
    expect: ok,
  },
  {
    id: "state-v2",
    group: "R",
    text: "stateDiagram-v2\n  [*] --> 待调度\n  待调度 --> 运行中: 调度成功\n  运行中 --> [*]\n  note right of 运行中\n    快照走 COW\n  end note",
    expect: ok,
  },
  { id: "state-v1", group: "R", text: "stateDiagram\n  [*] --> A\n  A --> B\n  B --> [*]", expect: ok },
  {
    id: "er",
    group: "R",
    text: "erDiagram\n  PROJECT ||--o{ SANDBOX : owns\n  SANDBOX {\n    string id PK\n    string name\n  }",
    expect: ok,
  },
  {
    id: "gantt",
    group: "R",
    text: "gantt\n  title 里程碑\n  dateFormat YYYY-MM-DD\n  section 控制面\n  API Gateway :done, cg1, 2026-10-06, 18d\n  Placement :active, cg2, 2026-10-20, 30d",
    expect: ok,
  },
  { id: "pie", group: "R", text: 'pie showData\n  title 资源占用\n  "系统预留" : 8\n  "用户负载" : 46', expect: ok },
  {
    id: "gitgraph",
    group: "R",
    text: "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev",
    expect: ok,
  },
  {
    id: "mindmap",
    group: "R",
    text: "mindmap\n  root((沙箱平台))\n    接入\n      SDK\n    控制面\n      Gateway",
    expect: ok,
  },
  {
    id: "journey",
    group: "R",
    text: "journey\n  title 旅程\n  section 起步\n    打开: 5: 我\n    试用: 3: 我, 你",
    expect: ok,
  },
  { id: "timeline", group: "R", text: "timeline\n  title 历史\n  2024 : 立项\n  2025 : 上线", expect: ok },
  {
    id: "quadrant",
    group: "R",
    text: "quadrantChart\n  title Q\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]",
    expect: ok,
  },
  {
    id: "xychart",
    group: "R",
    text: "xychart-beta\n  x-axis [a, b, c]\n  y-axis 0 --> 10\n  bar [3, 7, 5]",
    expect: ok,
  },
  { id: "sankey", group: "R", text: "sankey-beta\n\nA,B,10\nB,C,5", expect: ok },
  { id: "block", group: "R", text: "block-beta\n  columns 2\n  a b", expect: ok },
  { id: "kanban", group: "R", text: "kanban\n  todo[待办]\n    t1[任务一]", expect: ok },
  { id: "packet", group: "R", text: 'packet-beta\n  0-15: "Source"\n  16-31: "Dest"', expect: ok },
  { id: "radar", group: "R", text: "radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}", expect: ok },
  { id: "treemap", group: "R", text: 'treemap-beta\n"Root"\n    "A": 10\n    "B": 5', expect: ok },
  { id: "c4", group: "R", text: 'C4Context\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "uses")', expect: ok },
  {
    id: "requirement",
    group: "R",
    text: "requirementDiagram\n  requirement r {\n    id: 1\n    text: t\n    risk: high\n    verifymethod: test\n  }",
    expect: ok,
  },
  {
    id: "flow-subgraph-nested",
    group: "R",
    text: "flowchart LR\n  subgraph A[外层]\n    subgraph B[内层]\n      x --> y\n    end\n  end\n  y --> z",
    expect: ok,
  },

  /* Types that must be refused (G4): not in the first-version allow-list. */
  {
    id: "type-architecture",
    group: "N",
    text: "architecture-beta\n  group g(cloud)[G]\n  service s(server)[S] in g",
    expect: err("unsupported"),
  },
  { id: "type-info", group: "N", text: "info", expect: err("unsupported") },
  {
    id: "type-eventmodeling",
    group: "N",
    text: "eventmodeling\n  tf 01 evt Start",
    expect: err("unsupported", "parse"),
  },

  /* ------------------------------------------------------------------------------------- N */
  {
    id: "n-flow-img",
    group: "N",
    text: 'flowchart LR\n  A@{ img: "/probe-sink/flowimg.png", label: "x", pos: "b" } --> B',
    expect: err("unsupported"),
  },
  {
    id: "n-flow-img-yaml-escape",
    group: "N",
    text: 'flowchart LR\n  A@{ "\\x69mg": "/probe-sink/flowimgesc.png", label: "x" } --> B',
    expect: err("unsupported", "parse"),
  },
  {
    id: "n-seq-icon",
    group: "N",
    text: 'sequenceDiagram\n  participant A@{ "type": "actor" }\n  properties A: {"icon": "/probe-sink/seqicon.png"}\n  A->>A: hi',
    expect: err("unsupported", "parse"),
  },
  {
    id: "n-seq-icon-link",
    group: "N",
    text: 'sequenceDiagram\n  participant A\n  properties A: {"icon": "/probe-sink/seqicon2.png"}\n  A->>A: hi',
    expect: err("unsupported"),
  },
  {
    id: "n-seq-details",
    group: "N",
    text: "sequenceDiagram\n  participant A\n  details A: pwh-details-target\n  A->>A: hi",
    expect: err("unsupported"),
  },
  {
    id: "n-class-style-url",
    group: "N",
    text: "classDiagram\n  class A\n  style A fill:url(/probe-sink/classfill.svg#g)",
    expect: err("unsupported"),
  },
  {
    id: "n-class-style-url-css-escape",
    group: "N",
    text: "classDiagram\n  class A\n  style A fill:u\\72 l(/probe-sink/classfill2.svg#g)",
    expect: err("unsupported"),
  },
  {
    id: "n-class-style-url-hex",
    group: "N",
    text: "classDiagram\n  class A\n  style A fill:\\75rl(/probe-sink/classfill3.svg#g)",
    expect: err("unsupported"),
  },
  {
    id: "n-class-style-image-set",
    group: "N",
    text: 'classDiagram\n  class A\n  style A fill:image-set("/probe-sink/is.png" 1x)',
    expect: err("unsupported"),
  },
  {
    id: "n-class-style-entity",
    group: "N",
    text: "classDiagram\n  class A\n  style A fill:&#117;rl(/probe-sink/ent.svg#g)",
    expect: err("unsupported"),
  },
  {
    id: "n-class-def-url",
    group: "N",
    text: "flowchart LR\n  A --> B\n  classDef c fill:url(/probe-sink/classdef.svg#g)\n  class A c",
    expect: err("unsupported"),
  },
  {
    id: "n-state-style-url",
    group: "N",
    text: "stateDiagram-v2\n  [*] --> A\n  classDef c fill:url(/probe-sink/state.svg#g)\n  class A c",
    expect: err("unsupported"),
  },
  {
    id: "n-c4-style-url",
    group: "N",
    text: 'C4Context\n  Person(a, "A")\n  UpdateElementStyle(a, $bgColor="url(/probe-sink/c4.svg#g)")',
    expect: err("unsupported"),
  },
  {
    id: "n-frontmatter-url",
    group: "N",
    text: '---\nconfig:\n  themeVariables:\n    primaryColor: "url(/probe-sink/theme.svg#g)"\n---\nflowchart LR\n  A --> B',
    expect: err("unsupported"),
  },
  {
    id: "n-init-url",
    group: "N",
    text: '%%{init: {"themeVariables": {"lineColor": "url(/probe-sink/init.svg#g)"}}}%%\nflowchart LR\n  A --> B',
    expect: err("unsupported"),
  },
  {
    id: "n-arch-icontext-img",
    group: "N",
    text: "architecture-beta\n  service s1 \"<img src='/probe-sink/archtxt.png'> T\" [S1]",
    expect: err("unsupported"),
  },
  {
    id: "n-note-img-seq",
    group: "N",
    text: "sequenceDiagram\n  participant A\n  Note over A: <img src='/probe-sink/note.png'> hi\n  A->>A: <img src='/probe-sink/msg.png'> x",
    expect: any(),
  },
  {
    id: "n-label-img-flow",
    group: "N",
    text: "flowchart LR\n  A[\"<img src='/probe-sink/label.png'> x\"] --> B",
    expect: any(),
  },
  {
    id: "n-label-img-class",
    group: "N",
    text: "classDiagram\n  class A[\"<img src='/probe-sink/classlabel.png'>\"]",
    expect: any(),
  },
  {
    id: "n-label-svg-image",
    group: "N",
    text: "flowchart LR\n  A[\"<svg><image href='/probe-sink/svgimg.png'/></svg>\"] --> B",
    expect: any(),
  },
  {
    id: "n-label-link",
    group: "N",
    text: 'flowchart LR\n  A["<a href=\'/probe-sink/link\'>x</a>"] --> B\n  click A "/probe-sink/click"',
    expect: any(),
  },
  {
    id: "n-iconify-unregistered",
    group: "N",
    text: 'flowchart LR\n  A@{ icon: "logos:aws", form: "square", label: "aws" } --> B',
    expect: any(),
  },
  {
    id: "n-style-attr",
    group: "N",
    text: 'flowchart LR\n  A["x"] --> B\n  style A fill:#f00,stroke:#333,stroke-width:4px',
    expect: any(),
  },
  {
    id: "n-layout-swimlane",
    group: "N",
    text: "---\nconfig:\n  layout: swimlane\n---\nflowchart LR\n  A --> B",
    expect: err("parse"),
  },
  {
    id: "n-layout-cose",
    group: "N",
    text: '%%{init: {"flowchart": {"layout": "cose-bilkent"}}}%%\nflowchart LR\n  A --> B',
    expect: err("parse"),
  },
  {
    id: "n-layout-numiter",
    group: "N",
    text: '%%{init: {"architecture": {"numIter": 99999999}}}%%\nflowchart LR\n  A --> B',
    expect: err("unsupported"),
  },
  {
    id: "n-layout-elk-bound",
    group: "N",
    text: '%%{init: {"elk": {"layeringLayerBound": 99999}}}%%\nflowchart LR\n  A --> B',
    expect: err("unsupported"),
  },
  {
    id: "n-spacing-huge",
    group: "N",
    text: '%%{init: {"flowchart": {"nodeSpacing": 99999}}}%%\nflowchart LR\n  A --> B',
    expect: err("unsupported"),
  },

  /* ------------------------------------------------------------------------------------- C */
  {
    id: "c-init-overrides",
    group: "C",
    text: '%%{init: {"htmlLabels": true, "securityLevel": "loose", "themeCSS": ".node{fill:red}", "dompurifyConfig": {"ALLOWED_TAGS": ["img"]}, "themeVariables": {"fontSize": "99px"}, "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A --> B',
    expect: ok,
  },
  {
    id: "c-frontmatter-overrides",
    group: "C",
    text: '---\nconfig:\n  htmlLabels: true\n  securityLevel: loose\n  themeCSS: ".node{fill:red}"\n  dompurifyConfig:\n    ALLOWED_TAGS: [img]\n  flowchart:\n    htmlLabels: true\n---\nflowchart LR\n  A --> B',
    expect: ok,
  },
  {
    id: "c-actor-font-family",
    group: "C",
    text: '%%{init: {"sequence": {"actorFontFamily": "Papyrus"}}}%%\nsequenceDiagram\n  A->>B: hi',
    expect: err("unsupported"),
  },
  {
    id: "c-message-font-size",
    group: "C",
    text: '%%{init: {"sequence": {"messageFontSize": 99}}}%%\nsequenceDiagram\n  A->>B: hi',
    expect: err("unsupported"),
  },
  {
    id: "c-font-weight",
    group: "C",
    text: '%%{init: {"sequence": {"noteFontWeight": "expression(1)"}}}%%\nsequenceDiagram\n  A->>B: hi',
    expect: err("unsupported"),
  },
  {
    id: "c-theme-dark-author",
    group: "C",
    text: '%%{init: {"theme": "forest"}}%%\nflowchart LR\n  A --> B',
    expect: ok,
  },

  /* ------------------------------------------------------------------------------------- F */
  {
    id: "f-flow-long",
    group: "F",
    text: 'flowchart LR\n  A["这是一个很长很长的中文节点标签用来检查测量与显示的一致性"] --> B["A very long English label to check measurement vs display"]\n  B --> C{"判断条件：是否满足 / Is it OK?"}',
    expect: ok,
  },
  {
    id: "f-sequence-long",
    group: "F",
    text: "sequenceDiagram\n  participant A as 非常长的参与者名称用来检查\n  participant B as Another Very Long Participant\n  A->>B: 一条很长的中文消息 with English words mixed in\n  Note over A,B: 一个很长的备注 note text",
    expect: ok,
  },
  {
    id: "f-state-long",
    group: "F",
    text: "stateDiagram-v2\n  [*] --> 一个很长的状态名称用来检查\n  一个很长的状态名称用来检查 --> Another_Long_State_Name: 转移\n  Another_Long_State_Name --> [*]",
    expect: ok,
  },
  {
    id: "f-class-long",
    group: "F",
    text: "classDiagram\n  class 一个很长的类名用来检查测量 {\n    +一个很长的方法名称(参数) 返回值\n    +anotherVeryLongMethodName(argument) String\n  }",
    expect: ok,
  },
  {
    id: "f-mindmap",
    group: "F",
    text: "mindmap\n  root((根节点：沙箱平台))\n    第一个分支 with English\n      叶子节点一\n      叶子节点二\n    第二个分支",
    expect: ok,
  },

  /* ------------------------------------------------------------------------------------- M */
  { id: "m-flow", group: "M", text: 'flowchart LR\n  A["$$x^2$$"] --> B', expect: any() },
  { id: "m-sequence", group: "M", text: "sequenceDiagram\n  A->>B: $$x^2$$", expect: err("unsupported") },
  { id: "m-class", group: "M", text: "classDiagram\n  class A {\n    +f() $$x^2$$\n  }", expect: any() },
  { id: "m-state", group: "M", text: "stateDiagram-v2\n  [*] --> A: $$x^2$$", expect: any() },
  { id: "m-er", group: "M", text: 'erDiagram\n  A ||--o{ B : "$$x^2$$"', expect: any() },

  /* ------------------------------------------------------------------------------------- L */
  { id: "l-too-long", group: "L", text: "flowchart LR\n" + "  A --> B\n".repeat(2500), expect: err("too-large") },
  {
    id: "l-too-many-chars",
    group: "L",
    text: "flowchart LR\n  A[" + "x".repeat(20_001) + "] --> B",
    expect: err("too-large"),
  },
  { id: "l-dense-480", group: "L", text: dense(480), expect: ok },
  { id: "l-dense-501", group: "L", text: dense(501), expect: err("too-large") },
  { id: "l-coarse-201", group: "L", text: dense(201), expect: err("too-large") },
];

function any(): Expect {
  return { kind: "any" };
}
