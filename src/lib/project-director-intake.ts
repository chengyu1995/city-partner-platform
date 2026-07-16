const NEW_DEMAND_PREFIXES = ["新需求：", "新需求:"];

const ACCEPTANCE_FEEDBACK_PREFIXES = [
  "验收反馈：",
  "验收反馈:",
  "验收问题：",
  "验收问题:",
  "反馈：",
  "反馈:",
];

export type ProjectDirectorDemandKind =
  | "system_upgrade_request"
  | "website_product_request"
  | "other_request";

export type ProjectDirectorRequestType =
  | "system_upgrade"
  | "product_planning"
  | "ui_design"
  | "interaction_design"
  | "frontend_development"
  | "backend_development"
  | "testing_acceptance"
  | "operations_release"
  | "acceptance_feedback";

export type ProjectDirectorPlanningChoice = "homepage_mvp" | "complete_mvp_plan";

export type ProjectDirectorWorkRequestKind =
  | "document_organization"
  | "system_repair"
  | "product_design"
  | "other";

const WEBSITE_PRODUCT_KEYWORDS = [
  "网站",
  "页面",
  "首页",
  "功能",
  "产品",
  "登录",
  "注册",
  "后台",
  "CMS",
  "发布",
  "同城搭子",
  "搭子",
  "列表页",
  "详情页",
  "个人中心",
  "支付",
  "聊天",
  "搜索",
  "筛选",
  "用户流程",
  "UI",
  "前端",
  "后端",
  "部署",
];

const SYSTEM_UPGRADE_KEYWORDS = [
  "系统升级",
  "阶段 3",
  "阶段3",
  "3A",
  "3B",
  "3C",
  "Worker",
  "数据库",
  "SQL",
  "Supabase",
  "飞书接口",
  "Vercel API",
  "Hermes",
];

const APPROVAL_PHRASES = [
  "批准建议",
  "按你建议来",
  "就按这个做",
  "批准",
  "开始",
  "可以",
  "同意",
  "选 A",
  "选A",
  "选 B",
  "选B",
];

const TASK_TREE_REVIEW_PHRASES = [
  "批准任务树",
  "同意任务树",
  "按这个拆",
  "开始分发",
  "任务树可以",
  "就按这个任务树",
  "暂停",
];

const TASK_TREE_APPROVAL_PHRASES = [
  "批准任务树",
  "同意任务树",
  "按这个拆",
  "开始分发",
  "任务树可以",
  "就按这个任务树",
];

const TASK_TREE_CHANGE_PHRASES = [
  "先不要做",
  "增加",
  "删除",
  "改成",
];

const TASK_TREE_CHANGE_PREFIX = "修改任务树：";
const TASK_TREE_CHANGE_PREFIX_ASCII = "修改任务树:";
const TASK_TREE_ADJUST_PREFIX = "调整任务树：";
const TASK_TREE_ADJUST_PREFIX_ASCII = "调整任务树:";

const DISPATCH_PLAN_CHANGE_PREFIX = "修改分发清单：";
const DISPATCH_PLAN_CHANGE_PREFIX_ASCII = "修改分发清单:";

const DISPATCH_BATCH_APPROVAL_PHRASES = [
  "批准批次",
  "仅批准",
  "批准分发第 1 批",
  "批准分发第1批",
  "批准第 1 批",
  "批准第1批",
  "开始第 1 批",
  "开始第1批",
  "分发第 1 批",
  "分发第1批",
  "先做产品规划",
  "开始产品规划",
  "同意分发第 1 批",
  "同意分发第1批",
];

const APPROVED_EXECUTION_PHRASES = [
  "批准执行",
  "同意执行",
  "按计划执行",
  "开始执行",
  "批准全部执行",
];

const PLAN_CHANGE_PREFIX = "修改计划：";
const PLAN_CHANGE_PREFIX_ASCII = "修改计划:";

const PLANNING_CHOICE_A_PATTERNS = [/^选\s*A[。.!！]?$/i, /^选择\s*A[。.!！]?$/i];

const PLANNING_CHOICE_B_PATTERNS = [/^选\s*B[。.!！]?$/i, /^选择\s*B[。.!！]?$/i];

const DIRECT_WORKER_TASK_PATTERNS = [
  /请直接创建\s*Worker\s*任务/i,
  /直接创建\s*Worker\s*任务/i,
  /直接进入\s*Worker\s*创建流程/i,
  /跳过\s*A\/B\s*询问/i,
];

function normalizeDemandText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function parseProjectDirectorPlanningChoice(
  text: string
): ProjectDirectorPlanningChoice | null {
  const normalized = normalizeDemandText(text);
  if (PLANNING_CHOICE_A_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "homepage_mvp";
  }
  if (PLANNING_CHOICE_B_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "complete_mvp_plan";
  }
  return null;
}

export function isProjectDirectorPlanningChoiceReply(text: string): boolean {
  return parseProjectDirectorPlanningChoice(text) !== null;
}

export function isNewDemandMessage(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return NEW_DEMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isDirectWorkerTaskRequest(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return DIRECT_WORKER_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getDemandBody(text: string): string {
  const normalized = normalizeDemandText(text);
  const prefix = NEW_DEMAND_PREFIXES.find((item) => normalized.startsWith(item));
  return prefix ? normalized.slice(prefix.length).trim() : normalized;
}

export function isAcceptanceFeedbackMessage(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return ACCEPTANCE_FEEDBACK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function getAcceptanceFeedbackBody(text: string): string {
  const normalized = normalizeDemandText(text);
  const prefix = ACCEPTANCE_FEEDBACK_PREFIXES.find((item) => normalized.startsWith(item));
  return prefix ? normalized.slice(prefix.length).trim() : normalized;
}

export function isSystemUpgradeDemand(text: string): boolean {
  const demand = getDemandBody(text);
  return SYSTEM_UPGRADE_KEYWORDS.some((keyword) => demand.includes(keyword));
}

export function isProjectDirectorDemand(text: string): boolean {
  const kind = classifyProjectDirectorDemand(text);
  return kind === "system_upgrade_request" || kind === "website_product_request";
}

export function isWebsiteProductDemand(text: string): boolean {
  return classifyProjectDirectorDemand(text) === "website_product_request";
}

export function classifyProjectDirectorDemand(text: string): ProjectDirectorDemandKind {
  if (!isNewDemandMessage(text)) return "other_request";
  if (isSystemUpgradeDemand(text)) return "system_upgrade_request";
  const demand = getDemandBody(text);
  if (WEBSITE_PRODUCT_KEYWORDS.some((keyword) => demand.includes(keyword))) {
    return "website_product_request";
  }
  return "other_request";
}

export function classifyProjectDirectorWorkRequest(text: string): ProjectDirectorWorkRequestKind {
  const demand = getDemandBody(text);
  if (/文档|整理|归档|规范|README|docs?/i.test(demand)) return "document_organization";
  if (/系统|修复|故障|报错|bug|Worker|Hermes|飞书|BATCH|调度|接口|数据库|Supabase|SQL/i.test(demand)) {
    return "system_repair";
  }
  if (classifyProjectDirectorDemand(text) === "website_product_request") return "product_design";
  return "other";
}

export function classifyProjectDirectorRequestType(text: string): ProjectDirectorRequestType {
  const demand = getDemandBody(text);
  if (/验收|反馈|bug|修复/i.test(demand)) return "acceptance_feedback";
  if (/发布|部署|生产|Vercel|上线|release|deploy/i.test(demand)) return "operations_release";
  if (isSystemUpgradeDemand(text)) return "system_upgrade";
  if (/UI|视觉|样式|设计|配色|组件/i.test(demand)) return "ui_design";
  if (/交互|流程|状态|表单|路径|用户旅程/i.test(demand)) return "interaction_design";
  if (/后端|API|接口|数据|Supabase|RLS/i.test(demand)) return "backend_development";
  if (/测试|验收|检查|lint|typecheck|build/i.test(demand)) return "testing_acceptance";
  if (/前端|页面|组件|首页|列表|详情|登录|注册|个人主页/i.test(demand)) {
    return "frontend_development";
  }
  return "product_planning";
}

export function isBossApprovalReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  if (normalized.length <= 12) {
    return APPROVAL_PHRASES.some((phrase) => normalized === phrase);
  }
  return APPROVAL_PHRASES.some((phrase) => phrase.length > 2 && normalized.includes(phrase));
}

export function isTaskTreeReviewReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return (
    isTaskTreeChangeReply(normalized) ||
    TASK_TREE_REVIEW_PHRASES.some((phrase) => normalized === phrase)
  );
}

export function isTaskTreeApprovalReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return TASK_TREE_APPROVAL_PHRASES.some((phrase) => normalized === phrase);
}

export function isTaskTreeChangeReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return (
    normalized.startsWith(TASK_TREE_CHANGE_PREFIX) ||
    normalized.startsWith(TASK_TREE_CHANGE_PREFIX_ASCII) ||
    normalized.startsWith(TASK_TREE_ADJUST_PREFIX) ||
    normalized.startsWith(TASK_TREE_ADJUST_PREFIX_ASCII) ||
    TASK_TREE_CHANGE_PHRASES.some((phrase) => normalized.startsWith(phrase))
  );
}

export function isDispatchPlanChangeReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return (
    normalized.startsWith(DISPATCH_PLAN_CHANGE_PREFIX) ||
    normalized.startsWith(DISPATCH_PLAN_CHANGE_PREFIX_ASCII)
  );
}

export function isDispatchBatchApprovalReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return (
    DISPATCH_BATCH_APPROVAL_PHRASES.some((phrase) => normalized === phrase) ||
    isApprovedExecutionReply(normalized)
  );
}

export function isApprovedExecutionReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return APPROVED_EXECUTION_PHRASES.some((phrase) => normalized === phrase);
}

export function isPlanChangeReply(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return (
    normalized.startsWith(PLAN_CHANGE_PREFIX) ||
    normalized.startsWith(PLAN_CHANGE_PREFIX_ASCII)
  );
}

export function getPlanChangeReplyBody(text: string): string {
  const normalized = normalizeDemandText(text);
  if (normalized.startsWith(PLAN_CHANGE_PREFIX)) {
    return normalized.slice(PLAN_CHANGE_PREFIX.length).trim();
  }
  if (normalized.startsWith(PLAN_CHANGE_PREFIX_ASCII)) {
    return normalized.slice(PLAN_CHANGE_PREFIX_ASCII.length).trim();
  }
  return normalized;
}

export function buildPlanningChoiceOriginalDemand(
  choice: ProjectDirectorPlanningChoice,
  previousDemand?: string | null
): string {
  const fallback =
    choice === "homepage_mvp"
      ? "启动同城搭子网站 MVP 第一阶段：首页 MVP 规划"
      : "启动同城搭子网站 MVP 第一阶段：完整产品规划";
  return previousDemand?.trim() || fallback;
}

export function buildProjectDirectorPlanningChoiceReply(
  choice: ProjectDirectorPlanningChoice,
  originalDemand: string
): string {
  if (choice === "homepage_mvp") {
    return [
      "【项目总管：已选择 A，首页 MVP 规划】",
      `关联需求：${originalDemand}`,
      "",
      "首页目标",
      "- 用一个移动端优先的首页说明“同城搭子”是什么，并让用户能快速进入找搭子、发布搭子和筛选浏览。",
      "- 首页只输出规划，不写代码；必须等老板回复“总管 批准执行”后才进入 Worker/Codex。",
      "",
      "首页模块",
      "1. 顶部定位区：平台定位、城市生活氛围、主要行动入口。",
      "2. 搭子分类区：旅游、K 歌、学习、摩友、钓友等首批兴趣入口。",
      "3. 推荐搭子模块：展示少量示例搭子卡片，强调时间、地点、人数、标签和发起人。",
      "4. 发布搭子入口：突出“发布我的搭子需求”，但首版可先接到现有发布入口或规划占位。",
      "5. 筛选入口：城市、兴趣、时间三个轻量筛选维度。",
      "",
      "信息架构",
      "- 首页 -> 分类/筛选 -> 推荐搭子列表 -> 搭子详情。",
      "- 首页 -> 发布入口 -> 发布搭子表单。",
      "- 首页 -> 登录/个人状态预留。",
      "",
      "交互入口",
      "- 找搭子：进入列表或推荐模块。",
      "- 发布搭子：进入发布流程。",
      "- 筛选：打开轻量筛选条件。",
      "",
      "多 Agent 分工",
      "- 项目总管：冻结范围、拆批次、控制批准门禁。",
      "- 产品经理：补齐首页模块、优先级和验收口径。",
      "- UI 设计师：移动端首页视觉规范。",
      "- 交互设计师：首页入口和筛选流程。",
      "- 前端工程师：仅在批准后按允许文件实现。",
      "- 测试工程师：375px/768px、入口可达性、静态检查。",
      "",
      "执行批次",
      "1. 首页产品结构确认。",
      "2. 首页 UI/交互方案。",
      "3. 老板批准后再进入首页实现。",
      "4. 静态验证和验收回报。",
      "",
      "需要老板确认的问题",
      "- 首页首屏更强调“找搭子”还是“发布搭子”？",
      "- 首批分类是否固定为旅游/K 歌/学习/摩友/钓友？",
      "- 推荐搭子卡片使用 mock 示例还是已有数据入口？",
      "",
      "下一步可回复：修改计划：xxx / 总管 批准执行 / 总管 暂停",
    ].join("\n");
  }

  return [
    "【项目总管：已选择 B，完整 MVP 第一阶段规划】",
    `关联需求：${originalDemand}`,
    "",
    "产品目标",
    "- 用最小可上线范围验证同城兴趣搭子的核心闭环：发现搭子、查看详情、发布需求、形成后续联系意向。",
    "- 第一阶段只做规划输出，不写业务页面代码，不进入 Worker/Codex 执行队列。",
    "",
    "目标用户",
    "- 20-35 岁同城兴趣社交用户。",
    "- 有短期活动需求的人：旅游、K 歌、学习、自习、骑行、钓鱼等。",
    "- 希望低压力寻找同伴，但不想进入复杂社交关系的人。",
    "",
    "用户角色",
    "- 浏览者：查看搭子分类、推荐和详情。",
    "- 发布者：发布自己的搭子需求。",
    "- 参与者：通过详情页了解并表达参与意向。",
    "- 运营/老板：验收 MVP 范围、决定是否进入下一批开发。",
    "",
    "页面结构",
    "1. 首页：定位、分类、推荐搭子、发布入口、筛选入口。",
    "2. 搭子列表页：按分类/城市/时间筛选。",
    "3. 搭子详情页：活动信息、发起人、人数、时间地点、参与入口。",
    "4. 发布搭子页：标题、分类、时间、地点、人数、说明。",
    "5. 登录/注册/个人主页：第一阶段仅保留必要入口和状态，不扩大范围。",
    "",
    "核心流程",
    "- 找搭子：进入首页 -> 选择分类/筛选 -> 查看列表 -> 查看详情 -> 表达意向。",
    "- 发搭子：进入首页发布入口 -> 填写需求 -> 提交 -> 返回详情或列表可见。",
    "- 验收：老板按页面、流程、移动端、静态检查逐项验收。",
    "",
    "功能优先级",
    "- P0：首页、列表、详情、发布入口、移动端可用、mock/Supabase 双轨不破坏。",
    "- P1：筛选体验、推荐搭子卡片、用户状态预留。",
    "- P2：聊天、支付、复杂推荐、后台运营、多城市运营，本阶段不做。",
    "",
    "多 Agent 分工",
    "- 项目总管：确认范围、任务树、批准门禁、风险控制。",
    "- 产品经理：PRD、页面结构、优先级、验收标准。",
    "- UI 设计师：移动端视觉规范和组件状态。",
    "- 交互设计师：找搭子/发搭子/筛选流程。",
    "- 前端工程师：老板批准后实现允许范围内页面。",
    "- 后端工程师：老板批准后确认数据入口，不改数据库结构。",
    "- 测试工程师：lint/typecheck/build、移动端静态验收、F12 console 检查口径。",
    "- 运维工程师：仅记录预览/部署注意事项，不触发生产部署。",
    "",
    "执行批次",
    "1. BATCH-01：产品规划文档和验收口径。",
    "2. BATCH-02：UI/交互方案。",
    "3. BATCH-03：老板批准后实现首页与核心入口。",
    "4. BATCH-04：列表/详情/发布流程补齐。",
    "5. BATCH-05：静态验证、移动端检查、验收报告。",
    "",
    "验收标准",
    "- 页面结构覆盖首页、列表、详情、发布入口。",
    "- P0 流程能从首页走到详情和发布。",
    "- 移动端 375px/768px 不溢出，触摸目标可用。",
    "- TypeScript、ESLint、build 按 Worker 规则验证或记录 warning。",
    "- 未经老板批准不创建 Worker/Codex 执行任务。",
    "",
    "风险点",
    "- 范围膨胀到聊天/支付/后台会拖慢 MVP。",
    "- 数据库结构和 env 属于高风险边界，本阶段不改。",
    "- 云端飞书网关如果未同步 choice routing，仍可能重复 A/B，需要按文档同步。",
    "",
    "需要老板确认的问题",
    "- 第一阶段是否只覆盖旅游/K 歌/学习/摩友/钓友五类？",
    "- 发布后是否必须立刻在列表可见，还是先允许 mock 展示？",
    "- 登录是否作为 P0 强依赖，还是先做入口预留？",
    "",
    "下一步可回复：修改计划：xxx / 总管 批准执行 / 总管 暂停",
  ].join("\n");
}

export function buildProjectDirectorPlanningChoiceRecord(input: {
  choice: ProjectDirectorPlanningChoice;
  originalDemand: string;
  bossReply: string;
  planId: string;
}): string {
  return [
    "PROJECT_DIRECTOR_PLANNING_CHOICE",
    "state: waiting_execution_approval",
    `choice: ${input.choice}`,
    `plan_id: ${input.planId}`,
    `original_demand: ${input.originalDemand}`,
    `boss_reply: ${normalizeDemandText(input.bossReply)}`,
    "routing: handled_before_website_product_request",
    "hermes_jobs_created: no",
    "note: choice replies must not trigger another A/B confirmation.",
  ].join("\n");
}

export function buildProjectDirectorPlanChangeReply(changeText: string): string {
  const body = getPlanChangeReplyBody(changeText);
  const summary = body.length <= 160 ? body : `${body.slice(0, 157)}...`;
  return [
    "【项目总管：已记录修改计划】",
    `修改内容：${summary || "未填写具体内容"}`,
    "",
    "当前仍处于规划确认阶段，不会分发任务，也不会创建 Worker/Codex 执行任务。",
    "下一步可回复：选 A / 选 B / 总管 批准执行 / 总管 暂停",
  ].join("\n");
}

export function buildProjectDirectorPlanChangeRecord(changeText: string): string {
  return [
    "PROJECT_DIRECTOR_PLAN_CHANGE",
    "state: waiting_boss_reply",
    `change: ${getPlanChangeReplyBody(changeText)}`,
    "routing: handled_before_website_product_request",
    "hermes_jobs_created: no",
  ].join("\n");
}

function summarizeDemand(text: string): string {
  const demand = getDemandBody(text);
  if (demand === "做同城搭子网站首页") return "你想先做同城搭子网站首页";
  if (demand.length <= 80) return demand;
  return `${demand.slice(0, 77)}...`;
}

export function buildProjectDirectorReply(text: string): string {
  const summary = summarizeDemand(text);
  const workRequestKind = classifyProjectDirectorWorkRequest(text);

  if (workRequestKind === "document_organization") {
    return [
      "【项目总管确认】",
      `需求理解：${summary}`,
      "",
      "这属于文档整理任务，不是产品设计需求。我会按文档范围、文件边界和验收标准进入任务树规划。",
      "",
      "下一步老板可回复：",
      "- 批准执行",
      "- 修改计划：{你的要求}",
      "- 暂停",
    ].join("\n");
  }

  if (workRequestKind === "system_repair" && !isSystemUpgradeDemand(text)) {
    return [
      "【项目总管确认】",
      `需求理解：${summary}`,
      "",
      "这属于系统修复任务，不是产品设计需求。我会按故障范围、最小修复边界和验证步骤进入任务树规划。",
      "",
      "下一步老板可回复：",
      "- 批准执行",
      "- 修改计划：{你的要求}",
      "- 暂停",
    ].join("\n");
  }

  if (isSystemUpgradeDemand(text)) {
    return [
      "【项目总管确认】",
      `需求理解：${summary}`,
      "",
      "这属于系统升级需求，不是网站业务开发。我会先生成多 Agent 任务树和调度计划，并继续冻结首页、/post、/partners、登录、注册、个人主页等业务页面。",
      "",
      "规划阶段只会创建 1 个项目总管规划任务；只有你回复“批准执行”后，才会创建具体 Agent 执行任务。",
      "",
      "下一步老板只需回复：",
      "- 批准建议",
      "- 修改计划：{你的要求}",
      "- 暂停",
    ].join("\n");
  }

  if (summary === "你想先做同城搭子网站首页") {
    return [
      "【项目总管确认】",
      "我理解你的需求：",
      "你想先做同城搭子网站首页。",
      "",
      "我的建议：",
      "建议先做 MVP 首页，不要一开始做完整复杂平台。先让首页能清楚展示平台定位、搭子分类、找搭子入口和发布入口。",
      "",
      "我建议先这样做：",
      "1. 首页核心展示",
      "2. 搭子分类入口",
      "3. 搭子列表入口",
      "4. 发布入口预留",
      "5. 移动端适配",
      "",
      "关键问题：",
      "你希望首页首版更偏“找搭子列表”，还是更偏“发布搭子入口”？",
      "",
      "请回复：",
      "- 批准建议",
      "- 选 A：找搭子列表优先",
      "- 选 B：发布搭子入口优先",
      "- 补充要求：你的要求",
    ].join("\n");
  }

  return [
    "【项目总管确认】",
    `我理解你的需求：你想做 ${summary}。这属于网站/产品类需求，我会先确认范围，不直接分发给 Codex 执行。`,
    "",
    "我的建议：A 先做可上线的 MVP；B 一次做完整平台。推荐 A，因为先把页面和核心流程跑通，风险更低，也更容易验收。",
    "",
    "我建议先这样做：",
    "1. 首页或核心入口页面",
    "2. 列表页和详情页",
    "3. 基础发布或报名流程",
    "4. 移动端优先的 UI 状态",
    "5. 手工验收清单",
    "",
    "关键问题：首版是只做用户能看见的页面和核心流程，还是同时包含后台/支付/聊天等复杂能力？",
    "",
    "请回复：",
    "* 批准建议",
    "* 选 A",
    "* 选 B",
    "* 修改计划：{你的要求}",
    "* 或补充你的要求",
  ].join("\n");
}

export function buildBossApprovedReply(): string {
  return "已收到批准，下一阶段将进入任务树草案。";
}

export function buildProjectDirectorScopeUpdateReply(updateText: string): string {
  const normalized = normalizeDemandText(updateText);
  const summary = normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;

  return [
    "【项目总管确认】",
    "已收到补充需求，我会把它合并到当前待确认范围里。",
    "",
    `补充内容：${summary}`,
    "",
    "当前仍处于确认阶段，不会分发任务，也不会写入 Worker 队列。",
    "",
    "请继续回复：",
    "* 批准建议",
    "* 选 A",
    "* 选 B",
    "* 或继续补充要求",
  ].join("\n");
}

export function buildProjectDirectorScopeUpdateRecord(
  originalDemand: string,
  updateText: string
): string {
  return [
    "PROJECT_DIRECTOR_SCOPE_UPDATE",
    "state: waiting_boss_reply",
    `original_demand: ${originalDemand}`,
    `scope_update: ${normalizeDemandText(updateText)}`,
    "note: recorded only; no hermes_jobs queued task is created before boss approval.",
  ].join("\n");
}

export function buildTaskTreeReviewReceivedReply(): string {
  return "已收到任务树审核意见。下一阶段将进入任务分发准备。";
}

export function buildTaskTreeChangeRecordedReply(): string {
  return "已记录修改意见，下一阶段将重新生成任务树草案。本阶段不会分发任务，也不会写入 Worker 队列。";
}

export function buildDispatchPlanChangeRecordedReply(): string {
  return "已记录分发清单修改意见。本阶段不会真正分发任务，也不会创建 Worker 可领取的 queued 任务。";
}

export function buildDispatchBatchApprovalReceivedReply(): string {
  return "已收到分发第 1 批的确认。";
}
