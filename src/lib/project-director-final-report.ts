import type { HermesPlanAggregate } from "./hermes/result-aggregator.ts";

export interface ProjectDirectorFinalReport {
  report_schema_version: "1.0";
  plan_id: string;
  worker_status_title: string;
  task_status_title: string;
  worker_status: string;
  task_goal_status: string;
  effective_final_status: string;
  failure_code: string | null;
  failure_stage: string | null;
  aggregation_status: string;
  summary: string;
  feishu_projection: {
    projection_only: true;
    canonical_effective_final_status: string;
  };
}

export function buildProjectDirectorFinalReport(
  aggregate: HermesPlanAggregate
): ProjectDirectorFinalReport {
  const successful = aggregate.results.filter((result) => result.effective_final_status === "succeeded").length;
  const total = aggregate.results.length;
  return {
    report_schema_version: "1.0",
    plan_id: aggregate.plan_id,
    worker_status_title: `Worker execution status: ${aggregate.worker_status}`,
    task_status_title: `Task goal status: ${aggregate.task_goal_status}`,
    worker_status: aggregate.worker_status,
    task_goal_status: aggregate.task_goal_status,
    effective_final_status: aggregate.effective_final_status,
    failure_code: aggregate.failure_code,
    failure_stage: aggregate.failure_stage,
    aggregation_status: aggregate.aggregation_status,
    summary: `${successful}/${total} canonical subtasks succeeded; final=${aggregate.effective_final_status}`,
    feishu_projection: {
      projection_only: true,
      canonical_effective_final_status: aggregate.effective_final_status,
    },
  };
}
