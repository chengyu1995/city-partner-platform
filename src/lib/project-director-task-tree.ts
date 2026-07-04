import type {
  ProjectDirectorAgentRole,
  ProjectDirectorTaskType,
} from "@/lib/project-director-agents";

export type ProjectDirectorRole = ProjectDirectorAgentRole;
export type ProjectDirectorExecutionMode = "planning_only" | "approved_execution";
export type ProjectDirectorRiskLevel = "low" | "medium" | "high" | "critical";
export type ProjectDirectorDemandCategory =
  | "system_upgrade"
  | "product_planning"
  | "ui_design"
  | "frontend_development"
  | "backend_development"
  | "testing_acceptance"
  | "operations_release"
  | "acceptance_feedback";

export interface ProjectDirectorRootTask {
  task_key: string;
  title: string;
  agent_role: "project_director";
  task_type: ProjectDirectorTaskType;
  acceptance_criteria: string[];
}

export interface ProjectDirectorSubtask {
  task_code: string;
  task_key: string;
  task_title: string;
  title: string;
  role: ProjectDirectorRole;
  agent_role: ProjectDirectorRole;
  task_type: ProjectDirectorTaskType;
  stage: string;
  phase: string;
  input: string[];
  output_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  acceptance_criteria: string[];
  dependency_task_codes: string[];
  dependency_keys: string[];
  risk_level: ProjectDirectorRiskLevel;
  estimated_minutes: number;
  can_auto_execute: boolean;
  requires_boss_approval: boolean;
  execution_mode: ProjectDirectorExecutionMode;
}

export interface ProjectDirectorTaskGroup {
  code: string;
  title: string;
  tasks: ProjectDirectorSubtask[];
}

export interface ProjectDirectorStage {
  code: string;
  title: string;
  role: ProjectDirectorRole;
  task_groups: ProjectDirectorTaskGroup[];
}

export interface ProjectDirectorTaskTreeDraft {
  project_goal: string;
  task_tree_id: string;
  execution_mode: ProjectDirectorExecutionMode;
  root_task: ProjectDirectorRootTask;
  child_tasks: ProjectDirectorSubtask[];
  project: {
    title: string;
    goal: string;
    demand_category: ProjectDirectorDemandCategory;
    mvp_scope: string[];
    out_of_scope: string[];
    estimated_stages: string[];
  };
  stages: ProjectDirectorStage[];
}

const BUSINESS_FORBIDDEN_FILES = [
  "app/page.tsx",
  "app/post/page.tsx",
  "app/partners/page.tsx",
  "src/app/page.tsx",
  "src/app/post/page.tsx",
  "src/app/partners/page.tsx",
  ".env",
  ".env.local",
  "supabase/**",
  "package.json",
  "package-lock.json",
];

const SYSTEM_ALLOWED_FILES = [
  "src/lib/project-director-agents.ts",
  "src/lib/project-director-task-tree.ts",
  "src/lib/project-director-dispatch-plan.ts",
  "src/lib/project-director-job-builder.ts",
  "src/lib/project-director-intake.ts",
  "src/app/api/feishu/event/route.ts",
  "infra/windows-worker/local_worker.js",
  "docs/upgrade/batch-15-agent-dispatcher.md",
  "docs/upgrade/batch-15-task-tree-design.md",
  "docs/ops/agent-dispatch-architecture.md",
  "docs/ops/project-director-upgrade-roadmap.md",
  "docs/product/batch-15-agent-dispatcher-notes.md",
];

const DEFAULT_MVP_SCOPE = [
  "首页",
  "搭子分类",
  "搭子列表",
  "搭子详情",
  "发布搭子入口",
  "登录状态预留",
  "移动端适配",
];

const DEFAULT_OUT_OF_SCOPE = [
  "即时聊天",
  "支付",
  "复杂推荐算法",
  "复杂后台权限",
  "App、小程序、多城市运营系统",
];

function compactDemandTitle(demand: string): string {
  const normalized = demand.trim().replace(/\s+/g, " ");
  if (!normalized) return "同城搭子网站 MVP";
  if (normalized.length <= 28) return normalized;
  return `${normalized.slice(0, 25)}...`;
}

function createTaskTreeId(originalDemand: string): string {
  let hash = 0;
  for (let index = 0; index < originalDemand.length; index += 1) {
    hash = (hash * 31 + originalDemand.charCodeAt(index)) >>> 0;
  }
  return `task-tree-${hash.toString(16).padStart(8, "0")}`;
}

function detectDemandCategory(originalDemand: string): ProjectDirectorDemandCategory {
  if (/验收|反馈|bug|修复/i.test(originalDemand)) return "acceptance_feedback";
  if (/发布|部署|生产|Vercel|上线/i.test(originalDemand)) return "operations_release";
  if (/系统升级|BATCH|Worker|Hermes|调度|任务树|Agent|飞书|Supabase|数据库|SQL/i.test(originalDemand)) {
    return "system_upgrade";
  }
  if (/UI|视觉|样式|设计/i.test(originalDemand)) return "ui_design";
  if (/后端|API|接口|数据/i.test(originalDemand)) return "backend_development";
  if (/测试|验收|检查/i.test(originalDemand)) return "testing_acceptance";
  if (/前端|页面|组件|首页|列表|详情|登录|注册/i.test(originalDemand)) {
    return "frontend_development";
  }
  return "product_planning";
}

function requiresApprovalByBoundary(
  taskType: ProjectDirectorTaskType,
  allowedFiles: string[],
  riskLevel: ProjectDirectorRiskLevel,
  canAutoExecute: boolean
): boolean {
  if (!canAutoExecute || riskLevel === "high" || riskLevel === "critical") return true;
  if (taskType === "operations_release") return true;
  return allowedFiles.some((file) =>
    /supabase|sql|\.env|vercel|production|package\.json|package-lock\.json/i.test(file)
  );
}

function task(input: {
  task_code: string;
  task_title: string;
  role: ProjectDirectorRole;
  task_type: ProjectDirectorTaskType;
  stage: string;
  input: string[];
  allowed_files: string[];
  acceptance_criteria: string[];
  dependency_keys?: string[];
  forbidden_files?: string[];
  estimated_minutes?: number;
  can_auto_execute?: boolean;
  risk_level?: ProjectDirectorRiskLevel;
  execution_mode?: ProjectDirectorExecutionMode;
}): ProjectDirectorSubtask {
  const dependencyKeys = input.dependency_keys ?? [];
  const riskLevel = input.risk_level ?? "low";
  const canAutoExecute = input.can_auto_execute ?? true;
  const executionMode = input.execution_mode ?? "planning_only";
  const forbiddenFiles = input.forbidden_files ?? BUSINESS_FORBIDDEN_FILES;
  const requiresBossApproval = requiresApprovalByBoundary(
    input.task_type,
    input.allowed_files,
    riskLevel,
    canAutoExecute
  );

  return {
    task_code: input.task_code,
    task_key: input.task_code,
    task_title: input.task_title,
    title: input.task_title,
    role: input.role,
    agent_role: input.role,
    task_type: input.task_type,
    stage: input.stage,
    phase: input.stage,
    input: input.input,
    output_files: input.allowed_files,
    allowed_files: input.allowed_files,
    forbidden_files: forbiddenFiles,
    acceptance_criteria: input.acceptance_criteria,
    dependency_task_codes: dependencyKeys,
    dependency_keys: dependencyKeys,
    risk_level: riskLevel,
    estimated_minutes: input.estimated_minutes ?? 30,
    can_auto_execute: canAutoExecute,
    requires_boss_approval: requiresBossApproval,
    execution_mode: executionMode,
  };
}

function groupByStage(tasks: ProjectDirectorSubtask[]): ProjectDirectorStage[] {
  const order = [
    "INTAKE",
    "PRODUCT",
    "DESIGN",
    "FRONTEND",
    "BACKEND",
    "TEST",
    "OPS",
    "REPORT",
  ];
  const titleByStage: Record<string, string> = {
    INTAKE: "需求识别与总管规划",
    PRODUCT: "产品规划",
    DESIGN: "UI 与交互设计",
    FRONTEND: "前端开发",
    BACKEND: "后端开发",
    TEST: "测试验收",
    OPS: "运维发布",
    REPORT: "汇总回报",
  };
  const roleByStage: Record<string, ProjectDirectorRole> = {
    INTAKE: "project_director",
    PRODUCT: "product_manager",
    DESIGN: "ui_designer",
    FRONTEND: "frontend_developer",
    BACKEND: "backend_developer",
    TEST: "testing_engineer",
    OPS: "operations_engineer",
    REPORT: "project_director",
  };

  return order
    .map((stageCode) => {
      const stageTasks = tasks.filter((item) => item.stage === stageCode);
      if (stageTasks.length === 0) return null;
      return {
        code: stageCode,
        title: titleByStage[stageCode] ?? stageCode,
        role: roleByStage[stageCode] ?? stageTasks[0].role,
        task_groups: [
          {
            code: `${stageCode}-01`,
            title: titleByStage[stageCode] ?? stageCode,
            tasks: stageTasks,
          },
        ],
      } satisfies ProjectDirectorStage;
    })
    .filter((stage): stage is ProjectDirectorStage => Boolean(stage));
}

function buildSystemUpgradeTasks(originalDemand: string): ProjectDirectorSubtask[] {
  const baseInput = [
    `老板原始需求：${originalDemand}`,
    "本阶段性质：系统升级，不开发网站业务页面。",
    "冻结业务页面：app/page.tsx、app/post/page.tsx、app/partners/page.tsx、src/app/page.tsx、src/app/post/page.tsx、src/app/partners/page.tsx。",
  ];

  return [
    task({
      task_code: "BATCH-15-INTAKE-01",
      task_title: "识别需求类型并建立规划任务",
      role: "project_director",
      task_type: "system_upgrade",
      stage: "INTAKE",
      input: baseInput,
      allowed_files: [
        "src/lib/project-director-intake.ts",
        "src/app/api/feishu/event/route.ts",
        "src/lib/project-director-job-builder.ts",
      ],
      acceptance_criteria: [
        "能识别系统升级、产品规划、UI 设计、前端开发、后端开发、测试验收、运维发布、验收反馈",
        "规划阶段只生成项目总管规划任务",
        "老板未批准执行前不创建具体 Agent 执行任务",
      ],
      estimated_minutes: 45,
    }),
    task({
      task_code: "BATCH-15-AGENTS-01",
      task_title: "建立多 Agent 角色定义",
      role: "project_director",
      task_type: "system_upgrade",
      stage: "INTAKE",
      input: baseInput,
      allowed_files: ["src/lib/project-director-agents.ts"],
      acceptance_criteria: [
        "包含 8 个指定 Agent 角色",
        "每个角色定义 responsibility、allowed_task_types、allowed_file_scopes、forbidden_actions、output_format",
      ],
      dependency_keys: ["BATCH-15-INTAKE-01"],
      estimated_minutes: 35,
    }),
    task({
      task_code: "BATCH-15-TREE-01",
      task_title: "实现项目总管任务树生成器",
      role: "project_director",
      task_type: "system_upgrade",
      stage: "PRODUCT",
      input: baseInput,
      allowed_files: ["src/lib/project-director-task-tree.ts"],
      acceptance_criteria: [
        "输出 project_goal、task_tree_id、root_task、child_tasks",
        "每个子任务包含 agent_role、task_type、dependency_keys、acceptance_criteria、allowed_files、forbidden_files",
        "支持 planning_only 与 approved_execution",
      ],
      dependency_keys: ["BATCH-15-AGENTS-01"],
      estimated_minutes: 60,
    }),
    task({
      task_code: "BATCH-15-DISPATCH-01",
      task_title: "实现多 Agent 调度计划",
      role: "project_director",
      task_type: "system_upgrade",
      stage: "PRODUCT",
      input: baseInput,
      allowed_files: ["src/lib/project-director-dispatch-plan.ts"],
      acceptance_criteria: [
        "产品类先交 product_manager",
        "视觉和结构类交 ui_designer / interaction_designer",
        "代码任务交 frontend_developer / backend_developer",
        "Bug 和验收反馈先由 project_director 诊断",
        "发布和生产相关任务交 operations_engineer 且 requires_boss_approval 为 true",
      ],
      dependency_keys: ["BATCH-15-TREE-01"],
      estimated_minutes: 50,
    }),
    task({
      task_code: "BATCH-15-QUEUE-01",
      task_title: "实现兼容式任务入队策略",
      role: "backend_developer",
      task_type: "backend_development",
      stage: "BACKEND",
      input: baseInput,
      allowed_files: ["src/lib/project-director-job-builder.ts"],
      acceptance_criteria: [
        "子任务写入 hermes_jobs.request_text",
        "优先使用 request_text、source、workflow_stage、plan_status 等现有字段",
        "缺少可选字段时降级兼容，不失败",
      ],
      dependency_keys: ["BATCH-15-DISPATCH-01"],
      estimated_minutes: 55,
    }),
    task({
      task_code: "BATCH-15-FEISHU-01",
      task_title: "接入飞书项目总管回报格式",
      role: "backend_developer",
      task_type: "backend_development",
      stage: "BACKEND",
      input: baseInput,
      allowed_files: ["src/app/api/feishu/event/route.ts", "src/lib/project-director-intake.ts"],
      acceptance_criteria: [
        "规划回报只包含需求理解、Agent 子任务、执行顺序、需批准项、可自动执行项和下一步回复",
        "不向老板输出 SQL、PowerShell、堆栈或大段日志",
        "支持“批准执行 / 修改计划 / 暂停”",
      ],
      dependency_keys: ["BATCH-15-QUEUE-01"],
      estimated_minutes: 60,
    }),
    task({
      task_code: "BATCH-15-WORKER-01",
      task_title: "确认 Worker 调度兼容性",
      role: "operations_engineer",
      task_type: "operations_release",
      stage: "OPS",
      input: baseInput,
      allowed_files: ["infra/windows-worker/local_worker.js"],
      acceptance_criteria: [
        "保持 Worker 现有 request_text 领取流程兼容",
        "Codex prompt 保留禁止 git/dev server/browser 的强制规则",
        "静态诊断失败只记录 warning，不阻断任务",
      ],
      dependency_keys: ["BATCH-15-FEISHU-01"],
      estimated_minutes: 25,
      can_auto_execute: false,
      risk_level: "medium",
    }),
    task({
      task_code: "BATCH-15-DOCS-01",
      task_title: "补齐 BATCH-15 调度器文档",
      role: "project_director",
      task_type: "system_upgrade",
      stage: "REPORT",
      input: baseInput,
      allowed_files: SYSTEM_ALLOWED_FILES.filter((file) => file.startsWith("docs/")),
      acceptance_criteria: [
        "记录任务树设计",
        "记录 Agent 调度架构",
        "记录升级路线和产品侧说明",
      ],
      dependency_keys: ["BATCH-15-WORKER-01"],
      estimated_minutes: 45,
    }),
  ];
}

function buildProductTasks(originalDemand: string): ProjectDirectorSubtask[] {
  const baseInput = [`老板原始需求：${originalDemand}`, "先做规划，不直接开发业务页面。"];

  return [
    task({
      task_code: "PRODUCT-01-01",
      task_title: "输出 MVP PRD",
      role: "product_manager",
      task_type: "product_planning",
      stage: "PRODUCT",
      input: baseInput,
      allowed_files: ["docs/product/mvp-prd.md"],
      acceptance_criteria: ["明确 MVP 范围和暂不做范围", "覆盖核心用户故事", "列出验收口径"],
      estimated_minutes: 45,
    }),
    task({
      task_code: "PRODUCT-01-02",
      task_title: "输出页面清单和优先级",
      role: "product_manager",
      task_type: "product_planning",
      stage: "PRODUCT",
      input: baseInput,
      allowed_files: ["docs/product/page-list.md"],
      acceptance_criteria: ["列出首批页面", "标明依赖关系", "标明暂不做页面"],
      dependency_keys: ["PRODUCT-01-01"],
    }),
    task({
      task_code: "UI-01-01",
      task_title: "输出移动端优先视觉规范",
      role: "ui_designer",
      task_type: "ui_design",
      stage: "DESIGN",
      input: baseInput,
      allowed_files: ["docs/product/mobile-visual-spec.md"],
      acceptance_criteria: ["覆盖 375px 和 768px", "定义卡片、按钮、头像、标签和空状态"],
      dependency_keys: ["PRODUCT-01-02"],
    }),
    task({
      task_code: "IXD-01-01",
      task_title: "输出核心交互流程",
      role: "interaction_designer",
      task_type: "interaction_design",
      stage: "DESIGN",
      input: baseInput,
      allowed_files: ["docs/product/interaction-flow.md"],
      acceptance_criteria: ["覆盖主流程", "列出加载、空、错误状态", "标明登录预留"],
      dependency_keys: ["PRODUCT-01-02"],
    }),
    task({
      task_code: "FRONTEND-01-01",
      task_title: "检查前端实现范围",
      role: "frontend_developer",
      task_type: "frontend_development",
      stage: "FRONTEND",
      input: baseInput,
      allowed_files: ["docs/product/frontend-implementation-scope.md"],
      acceptance_criteria: ["不修改业务页面", "列出后续需老板批准的业务文件范围"],
      dependency_keys: ["UI-01-01", "IXD-01-01"],
      can_auto_execute: false,
      risk_level: "medium",
    }),
    task({
      task_code: "TEST-01-01",
      task_title: "输出测试验收清单",
      role: "testing_engineer",
      task_type: "testing_acceptance",
      stage: "TEST",
      input: baseInput,
      allowed_files: ["docs/product/acceptance-criteria.md"],
      acceptance_criteria: ["覆盖页面、交互、移动端、lint、typecheck、build"],
      dependency_keys: ["FRONTEND-01-01"],
    }),
  ];
}

function buildTasksForDemand(originalDemand: string): ProjectDirectorSubtask[] {
  const category = detectDemandCategory(originalDemand);
  if (category === "system_upgrade") return buildSystemUpgradeTasks(originalDemand);
  return buildProductTasks(originalDemand);
}

export function buildProjectDirectorTaskTreeDraft(
  originalDemand: string,
  bossConfirmation = "规划阶段",
  executionMode: ProjectDirectorExecutionMode = "planning_only"
): ProjectDirectorTaskTreeDraft {
  const projectTitle = compactDemandTitle(originalDemand);
  const demandCategory = detectDemandCategory(originalDemand);
  const taskTreeId = createTaskTreeId(`${originalDemand}:${executionMode}`);
  const childTasks = buildTasksForDemand(originalDemand).map((item) => ({
    ...item,
    execution_mode: executionMode,
  }));
  const rootTask: ProjectDirectorRootTask = {
    task_key: "ROOT",
    title: "项目总管任务树规划与调度",
    agent_role: "project_director",
    task_type: demandCategory === "system_upgrade" ? "system_upgrade" : "product_planning",
    acceptance_criteria: [
      "完成需求类型识别",
      "生成多 Agent 子任务",
      "标明依赖、验收条件、允许修改范围和审批边界",
      `老板确认：${bossConfirmation}`,
    ],
  };
  const projectGoal =
    demandCategory === "system_upgrade"
      ? "升级项目总管为多 Agent 调度器，同时继续冻结网站业务开发。"
      : "把老板需求拆成可审核、可分批执行的 MVP 任务树，先规划再执行。";

  return {
    project_goal: projectGoal,
    task_tree_id: taskTreeId,
    execution_mode: executionMode,
    root_task: rootTask,
    child_tasks: childTasks,
    project: {
      title: projectTitle,
      goal: projectGoal,
      demand_category: demandCategory,
      mvp_scope: demandCategory === "system_upgrade" ? ["多 Agent 角色", "任务树", "调度计划", "兼容入队", "飞书回报"] : DEFAULT_MVP_SCOPE,
      out_of_scope:
        demandCategory === "system_upgrade"
          ? ["业务页面开发", "数据库结构升级", "生产部署", "安装新依赖"]
          : DEFAULT_OUT_OF_SCOPE,
      estimated_stages: groupByStage(childTasks).map((stage) => stage.title),
    },
    stages: groupByStage(childTasks),
  };
}

export function buildTaskTreeDraftSummary(draft: ProjectDirectorTaskTreeDraft): string {
  const autoTasks = draft.child_tasks.filter((taskItem) => !taskItem.requires_boss_approval);
  const approvalTasks = draft.child_tasks.filter((taskItem) => taskItem.requires_boss_approval);

  return [
    "【项目总管：任务树草案】",
    `需求理解：${draft.project_goal}`,
    `任务树编号：${draft.task_tree_id}`,
    "",
    "拆分出的 Agent 子任务：",
    ...draft.child_tasks.map(
      (taskItem, index) =>
        `${index + 1}. ${taskItem.agent_role} / ${taskItem.task_type}：${taskItem.task_title}`
    ),
    "",
    "执行顺序：",
    ...draft.stages.map((stage, index) => `${index + 1}. ${stage.title}`),
    "",
    "需要老板批准：",
    ...(approvalTasks.length
      ? approvalTasks.map((taskItem) => `- ${taskItem.task_code}：${taskItem.task_title}`)
      : ["- 无"]),
    "",
    "可以自动执行：",
    ...(autoTasks.length ? autoTasks.map((taskItem) => `- ${taskItem.task_code}：${taskItem.task_title}`) : ["- 无"]),
    "",
    "下一步老板只需回复：",
    "- 批准执行",
    "- 修改计划：{你的要求}",
    "- 暂停",
  ].join("\n");
}

export function buildTaskTreeDraftRecord(
  originalDemand: string,
  bossConfirmation: string,
  draft: ProjectDirectorTaskTreeDraft,
  summary: string
): string {
  return [
    "PROJECT_DIRECTOR_TASK_TREE_DRAFT",
    "state: waiting_execution_approval",
    `original_demand: ${originalDemand}`,
    `boss_confirmation: ${bossConfirmation}`,
    `execution_mode: ${draft.execution_mode}`,
    "summary:",
    summary,
    "json:",
    JSON.stringify(draft, null, 2),
  ].join("\n");
}
