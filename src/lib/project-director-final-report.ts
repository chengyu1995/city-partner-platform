import type { HermesPlanAggregate } from "./hermes/result-aggregator.ts";
import type { HermesShadowObservation } from "./hermes/shadow-runtime.ts";

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

export interface ProjectDirectorShadowReport<T> {
  gm_report_primary_source: "legacy_runtime";
  gm_report_shadow_source: "hermes_shadow_comparison";
  primary_result: T;
  shadow_observation: HermesShadowObservation;
}

export function attachHermesShadowComparison<T>(
  primaryResult: T,
  shadowObservation: HermesShadowObservation
): ProjectDirectorShadowReport<T> {
  return {
    gm_report_primary_source: "legacy_runtime",
    gm_report_shadow_source: "hermes_shadow_comparison",
    primary_result: primaryResult,
    shadow_observation: shadowObservation,
  };
}

export type ProjectDirectorFinalReportWithShadow<T extends Record<string, unknown>> = T & {
  gm_report_primary_source: "legacy_runtime";
  gm_report_shadow_source: "hermes_shadow_comparison";
  hermes_shadow_observation: HermesShadowObservation;
  hermes_shadow_comparison: HermesShadowObservation["report"];
};

export function attachHermesShadowToFinalReport<T extends Record<string, unknown>>(
  primaryResult: T,
  shadowObservation: HermesShadowObservation
): ProjectDirectorFinalReportWithShadow<T> {
  return {
    ...primaryResult,
    gm_report_primary_source: "legacy_runtime",
    gm_report_shadow_source: "hermes_shadow_comparison",
    hermes_shadow_observation: shadowObservation,
    hermes_shadow_comparison: shadowObservation.report,
  };
}
