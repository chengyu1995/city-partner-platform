import {
  getProjectDirectorAgentDefinition,
  type ProjectDirectorAgentRole,
} from "@/lib/project-director-agents";
import type {
  ProjectDirectorExecutionMode,
  ProjectDirectorRiskLevel,
  ProjectDirectorSubtask,
  ProjectDirectorTaskTreeDraft,
} from "@/lib/project-director-task-tree";

export interface ProjectDirectorDispatchTask {
  task_code: string;
  task_key: string;
  task_title: string;
  role: ProjectDirectorAgentRole;
  agent_role: ProjectDirectorAgentRole;
  task_type: ProjectDirectorSubtask["task_type"];
  stage: string;
  task_group: string;
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
  dispatch_batch: string;
  requires_boss_approval: boolean;
  blocked_reason: string;
  execution_mode: ProjectDirectorExecutionMode;
}

export interface ProjectDirectorDispatchBatch {
  batch_code: string;
  title: string;
  roles: ProjectDirectorAgentRole[];
  stage_codes: string[];
  tasks: ProjectDirectorDispatchTask[];
}

export interface ProjectDirectorDispatchPlanDraft {
  project: {
    title: string;
    goal: string;
    task_tree_id: string;
  };
  dispatch_plan: {
    status: "waiting_dispatch_approval" | "approved_execution";
    execution_mode: ProjectDirectorExecutionMode;
    recommended_first_batch: string;
    batches: ProjectDirectorDispatchBatch[];
    automatic_task_keys: string[];
    approval_required_task_keys: string[];
  };
}

const BATCH_DEFINITIONS: Array<{
  batch_code: string;
  title: string;
  roles: ProjectDirectorAgentRole[];
  stage_codes: string[];
}> = [
  {
    batch_code: "BATCH-00",
    title: "项目总管规划",
    roles: ["project_director"],
    stage_codes: ["INTAKE"],
  },
  {
    batch_code: "BATCH-01",
    title: "产品规划",
    roles: ["product_manager"],
    stage_codes: ["PRODUCT"],
  },
  {
    batch_code: "BATCH-02",
    title: "设计与交互",
    roles: ["ui_designer", "interaction_designer"],
    stage_codes: ["DESIGN", "UI", "IXD"],
  },
  {
    batch_code: "BATCH-03",
    title: "后端与数据边界",
    roles: ["backend_developer"],
    stage_codes: ["BACKEND"],
  },
  {
    batch_code: "BATCH-04",
    title: "前端开发",
    roles: ["frontend_developer"],
    stage_codes: ["FRONTEND"],
  },
  {
    batch_code: "BATCH-05",
    title: "测试验收",
    roles: ["testing_engineer"],
    stage_codes: ["TEST"],
  },
  {
    batch_code: "BATCH-06",
    title: "运维发布",
    roles: ["operations_engineer"],
    stage_codes: ["OPS", "RELEASE"],
  },
  {
    batch_code: "BATCH-07",
    title: "汇总回报",
    roles: ["project_director"],
    stage_codes: ["REPORT"],
  },
];

const BATCH_CODE_BY_STAGE: Record<string, string> = {
  INTAKE: "BATCH-00",
  PRODUCT: "BATCH-01",
  DESIGN: "BATCH-02",
  UI: "BATCH-02",
  IXD: "BATCH-02",
  BACKEND: "BATCH-03",
  FRONTEND: "BATCH-04",
  TEST: "BATCH-05",
  OPS: "BATCH-06",
  RELEASE: "BATCH-06",
  REPORT: "BATCH-07",
};

const BOSS_APPROVAL_FILE_PATTERNS = [
  /\.env/i,
  /supabase/i,
  /\.sql$/i,
  /package\.json$/i,
  /package-lock\.json$/i,
  /vercel/i,
  /production/i,
];

function includesApprovalBoundary(task: ProjectDirectorSubtask): boolean {
  if (task.task_type === "operations_release") return true;
  if (task.risk_level === "high" || task.risk_level === "critical") return true;
  if (!task.can_auto_execute || task.requires_boss_approval) return true;
  return task.allowed_files.some((file) =>
    BOSS_APPROVAL_FILE_PATTERNS.some((pattern) => pattern.test(file))
  );
}

function getBlockedReason(task: ProjectDirectorSubtask): string {
  if (!includesApprovalBoundary(task)) return "";
  if (task.task_type === "operations_release") return "发布、部署或生产环境相关任务必须老板批准。";
  if (task.allowed_files.some((file) => /supabase|\.sql$/i.test(file))) {
    return "涉及数据库结构或 SQL，必须老板批准。";
  }
  if (task.allowed_files.some((file) => /\.env|vercel|production/i.test(file))) {
    return "涉及密钥、环境变量或生产配置，必须老板批准。";
  }
  if (!task.can_auto_execute) return "任务被标记为不可自动执行，必须老板批准。";
  return "任务风险较高，必须老板批准。";
}

function mapTask(
  task: ProjectDirectorSubtask,
  taskGroup: string,
  dispatchBatch: string,
  executionMode: ProjectDirectorExecutionMode
): ProjectDirectorDispatchTask {
  return {
    task_code: task.task_code,
    task_key: task.task_key,
    task_title: task.task_title,
    role: task.role,
    agent_role: task.agent_role,
    task_type: task.task_type,
    stage: task.stage,
    task_group: taskGroup,
    input: task.input,
    output_files: task.output_files,
    allowed_files: task.allowed_files,
    forbidden_files: task.forbidden_files,
    acceptance_criteria: task.acceptance_criteria,
    dependency_task_codes: task.dependency_task_codes,
    dependency_keys: task.dependency_keys,
    risk_level: task.risk_level,
    estimated_minutes: task.estimated_minutes,
    can_auto_execute: task.can_auto_execute,
    dispatch_batch: dispatchBatch,
    requires_boss_approval: includesApprovalBoundary(task),
    blocked_reason: getBlockedReason(task),
    execution_mode: executionMode,
  };
}

export function buildProjectDirectorDispatchPlanDraft(
  taskTreeDraft: ProjectDirectorTaskTreeDraft,
  executionMode: ProjectDirectorExecutionMode = taskTreeDraft.execution_mode
): ProjectDirectorDispatchPlanDraft {
  const batches = BATCH_DEFINITIONS.map((definition) => ({
    ...definition,
    tasks: [] as ProjectDirectorDispatchTask[],
  }));
  const batchByCode = new Map(batches.map((batch) => [batch.batch_code, batch]));

  for (const stage of taskTreeDraft.stages) {
    const batchCode = BATCH_CODE_BY_STAGE[stage.code] ?? "BATCH-04";
    const batch = batchByCode.get(batchCode);
    if (!batch) continue;

    for (const group of stage.task_groups) {
      for (const task of group.tasks) {
        batch.tasks.push(mapTask(task, group.title, batchCode, executionMode));
      }
    }
  }

  const allTasks = batches.flatMap((batch) => batch.tasks);
  const approvalRequired = allTasks.filter((task) => task.requires_boss_approval);
  const automatic = allTasks.filter((task) => !task.requires_boss_approval);

  return {
    project: {
      title: taskTreeDraft.project.title,
      goal: taskTreeDraft.project.goal,
      task_tree_id: taskTreeDraft.task_tree_id,
    },
    dispatch_plan: {
      status: executionMode === "approved_execution" ? "approved_execution" : "waiting_dispatch_approval",
      execution_mode: executionMode,
      recommended_first_batch: batches.find((batch) => batch.tasks.length > 0)?.batch_code ?? "BATCH-00",
      batches,
      automatic_task_keys: automatic.map((task) => task.task_key),
      approval_required_task_keys: approvalRequired.map((task) => task.task_key),
    },
  };
}

export function buildDispatchPlanSummary(plan: ProjectDirectorDispatchPlanDraft): string {
  const activeBatches = plan.dispatch_plan.batches.filter((batch) => batch.tasks.length > 0);
  const allTasks = activeBatches.flatMap((batch) => batch.tasks);
  const approvalTasks = allTasks.filter((task) => task.requires_boss_approval);
  const automaticTasks = allTasks.filter((task) => !task.requires_boss_approval);

  return [
    "【项目总管：待分发任务清单】",
    `需求理解：${plan.project.goal}`,
    `任务树编号：${plan.project.task_tree_id}`,
    "",
    "拆分出的 Agent 子任务：",
    ...allTasks.map((task, index) => {
      const roleName = getProjectDirectorAgentDefinition(task.agent_role).display_name;
      return `${index + 1}. ${roleName}：${task.task_title}`;
    }),
    "",
    "执行顺序：",
    ...activeBatches.map((batch, index) => `${index + 1}. ${batch.title}（${batch.tasks.length} 个任务）`),
    "",
    "需要老板批准：",
    ...(approvalTasks.length
      ? approvalTasks.map((task) => `- ${task.task_key}：${task.blocked_reason}`)
      : ["- 无"]),
    "",
    "可以自动执行：",
    ...(automaticTasks.length
      ? automaticTasks.map((task) => `- ${task.task_key}：${task.task_title}`)
      : ["- 无"]),
    "",
    "下一步老板只需回复：",
    "- 批准执行",
    "- 修改计划：{你的要求}",
    "- 暂停",
  ].join("\n");
}

export function buildDispatchPlanDraftRecord(
  originalDemand: string,
  bossConfirmation: string,
  taskTreeDraft: ProjectDirectorTaskTreeDraft,
  dispatchPlan: ProjectDirectorDispatchPlanDraft,
  summary: string
): string {
  return [
    "PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT",
    `state: ${dispatchPlan.dispatch_plan.status}`,
    `original_demand: ${originalDemand}`,
    `boss_confirmation: ${bossConfirmation}`,
    `execution_mode: ${dispatchPlan.dispatch_plan.execution_mode}`,
    "task_tree_json:",
    JSON.stringify(taskTreeDraft, null, 2),
    "dispatch_plan_json:",
    JSON.stringify(dispatchPlan, null, 2),
    "summary:",
    summary,
  ].join("\n");
}

export function buildReviewChangeRecord(reviewText: string): string {
  return [
    "PROJECT_DIRECTOR_TASK_TREE_REVIEW_CHANGE",
    "state: task_tree_change_requested",
    `review_text: ${reviewText}`,
    "note: recorded only; no hermes_jobs queued execution task is created before boss approval.",
  ].join("\n");
}

export function buildDispatchPlanChangeRecord(reviewText: string): string {
  return [
    "PROJECT_DIRECTOR_DISPATCH_PLAN_CHANGE",
    "state: dispatch_plan_change_requested",
    `review_text: ${reviewText}`,
    "note: recorded only; no hermes_jobs queued execution task is created before boss approval.",
  ].join("\n");
}
