import type {
  ProjectDirectorRole,
  ProjectDirectorSubtask,
  ProjectDirectorTaskTreeDraft,
} from "@/lib/project-director-task-tree";

export interface ProjectDirectorDispatchTask {
  task_code: string;
  task_title: string;
  role: ProjectDirectorRole;
  stage: string;
  task_group: string;
  input: string[];
  output_files: string[];
  acceptance_criteria: string[];
  dependency_task_codes: string[];
  risk_level: ProjectDirectorSubtask["risk_level"];
  estimated_minutes: number;
  can_auto_execute: boolean;
  dispatch_batch: string;
  requires_boss_approval: boolean;
  blocked_reason: string;
}

export interface ProjectDirectorDispatchBatch {
  batch_code: string;
  title: string;
  roles: ProjectDirectorRole[];
  tasks: ProjectDirectorDispatchTask[];
}

export interface ProjectDirectorDispatchPlanDraft {
  project: {
    title: string;
    goal: string;
  };
  dispatch_plan: {
    status: "waiting_dispatch_approval";
    recommended_first_batch: "BATCH-01";
    batches: ProjectDirectorDispatchBatch[];
  };
}

const BATCH_DEFINITIONS: Array<{
  batch_code: string;
  title: string;
  roles: ProjectDirectorRole[];
  stage_codes: string[];
}> = [
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
    stage_codes: ["UI", "IXD"],
  },
  {
    batch_code: "BATCH-03",
    title: "技术设计",
    roles: ["backend_developer"],
    stage_codes: ["BACKEND"],
  },
  {
    batch_code: "BATCH-04",
    title: "开发实现",
    roles: ["frontend_developer", "backend_developer"],
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
    title: "部署上线",
    roles: ["operations_engineer"],
    stage_codes: ["RELEASE"],
  },
];

const FALLBACK_BATCH_CODE_BY_STAGE: Record<string, string> = {
  PRODUCT: "BATCH-01",
  UI: "BATCH-02",
  IXD: "BATCH-02",
  BACKEND: "BATCH-03",
  FRONTEND: "BATCH-04",
  TEST: "BATCH-05",
  RELEASE: "BATCH-06",
};

function shouldRequireBossApproval(task: ProjectDirectorSubtask): boolean {
  return !task.can_auto_execute || task.risk_level === "high" || task.risk_level === "critical";
}

function getBlockedReason(task: ProjectDirectorSubtask): string {
  if (task.can_auto_execute && task.risk_level === "low") return "";
  if (!task.can_auto_execute) return "该任务涉及人工确认或高风险边界，分发前需要老板单独批准。";
  return "该任务风险较高，分发前需要老板单独批准。";
}

function mapTask(
  task: ProjectDirectorSubtask,
  stage: string,
  taskGroup: string,
  dispatchBatch: string
): ProjectDirectorDispatchTask {
  return {
    task_code: task.task_code,
    task_title: task.task_title,
    role: task.role,
    stage,
    task_group: taskGroup,
    input: task.input,
    output_files: task.output_files,
    acceptance_criteria: task.acceptance_criteria,
    dependency_task_codes: task.dependency_task_codes,
    risk_level: task.risk_level,
    estimated_minutes: task.estimated_minutes,
    can_auto_execute: task.can_auto_execute,
    dispatch_batch: dispatchBatch,
    requires_boss_approval: shouldRequireBossApproval(task),
    blocked_reason: getBlockedReason(task),
  };
}

export function buildProjectDirectorDispatchPlanDraft(
  taskTreeDraft: ProjectDirectorTaskTreeDraft
): ProjectDirectorDispatchPlanDraft {
  const batches = BATCH_DEFINITIONS.map((definition) => ({
    batch_code: definition.batch_code,
    title: definition.title,
    roles: definition.roles,
    tasks: [] as ProjectDirectorDispatchTask[],
  }));

  const batchByCode = new Map(batches.map((batch) => [batch.batch_code, batch]));

  for (const stage of taskTreeDraft.stages) {
    const batchCode = FALLBACK_BATCH_CODE_BY_STAGE[stage.code] ?? "BATCH-04";
    const batch = batchByCode.get(batchCode);
    if (!batch) continue;

    for (const group of stage.task_groups) {
      for (const task of group.tasks) {
        batch.tasks.push(mapTask(task, stage.title, group.title, batchCode));
      }
    }
  }

  return {
    project: {
      title: taskTreeDraft.project.title,
      goal: taskTreeDraft.project.goal,
    },
    dispatch_plan: {
      status: "waiting_dispatch_approval",
      recommended_first_batch: "BATCH-01",
      batches,
    },
  };
}

export function buildDispatchPlanSummary(plan: ProjectDirectorDispatchPlanDraft): string {
  const batchLines = plan.dispatch_plan.batches.map(
    (batch, index) => `${index + 1}. ${batch.title}：${batch.tasks.length} 个任务`
  );

  const defaultRecommendations = [
    "产品经理：输出 PRD",
    "产品经理：输出页面清单",
    "产品经理：输出用户流程",
    "产品经理：输出验收标准",
    "UI 设计师：输出设计规范",
    "前端工程师：检查现有页面结构",
  ];

  return [
    "【项目总管：待分发任务清单】",
    "任务树已审核通过，我已生成待分发清单。",
    "",
    `项目： ${plan.project.title}`,
    "",
    "分发批次：",
    ...batchLines,
    "",
    "首批建议执行：",
    ...defaultRecommendations.map((item, index) => `${index + 1}. ${item}`),
    "",
    "我建议：",
    "先只批准第 1 批“产品规划”，不要一次让全部 Agent 同时开工。这样可以先把需求、页面和验收标准定清楚，避免后面返工。",
    "",
    "关键确认：",
    "是否批准分发第 1 批产品规划任务？",
    "请回复：",
    "* 批准分发第 1 批",
    "* 修改分发清单：{你的要求}",
    "* 暂停",
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
    "state: waiting_dispatch_approval",
    `original_demand: ${originalDemand}`,
    `boss_confirmation: ${bossConfirmation}`,
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
    "note: recorded only; no hermes_jobs queued task is created in phase 3D.",
  ].join("\n");
}

export function buildDispatchPlanChangeRecord(reviewText: string): string {
  return [
    "PROJECT_DIRECTOR_DISPATCH_PLAN_CHANGE",
    "state: dispatch_plan_change_requested",
    `review_text: ${reviewText}`,
    "note: recorded only; no hermes_jobs queued task is created in phase 3D.",
  ].join("\n");
}
