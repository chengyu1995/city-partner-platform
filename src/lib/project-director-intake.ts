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

function normalizeDemandText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function isNewDemandMessage(text: string): boolean {
  const normalized = normalizeDemandText(text);
  return NEW_DEMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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
  return DISPATCH_BATCH_APPROVAL_PHRASES.some((phrase) => normalized === phrase);
}

function summarizeDemand(text: string): string {
  const demand = getDemandBody(text);
  if (demand === "做同城搭子网站首页") return "你想先做同城搭子网站首页";
  if (demand.length <= 80) return demand;
  return `${demand.slice(0, 77)}...`;
}

export function buildProjectDirectorReply(text: string): string {
  const summary = summarizeDemand(text);
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
