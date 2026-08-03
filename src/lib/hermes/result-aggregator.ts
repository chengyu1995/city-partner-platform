import type { HermesExecutionPlan } from "./execution-plan.ts";

export type CanonicalEffectiveFinalStatus = "succeeded" | "failed" | "cancelled" | "blocked";
export type HermesAggregationStatus =
  | "all_success"
  | "partial_failure"
  | "blocked_dependency"
  | "cancelled"
  | "mixed_terminal_results";

export interface CanonicalSubtaskResult {
  subtask_id: string;
  report_identity: string;
  worker_status: string;
  task_goal_status: string;
  effective_final_status: string;
  failure_code: string | null;
  failure_stage: string | null;
}

export interface AggregatedSubtaskResult extends CanonicalSubtaskResult {
  effective_final_status: CanonicalEffectiveFinalStatus;
  duplicate_terminal_reports_ignored: number;
  synthetic: boolean;
}

export interface HermesPlanAggregate {
  plan_id: string;
  plan_hash: string;
  aggregation_status: HermesAggregationStatus;
  worker_status: string;
  task_goal_status: string;
  effective_final_status: "succeeded" | "failed" | "cancelled";
  failure_code: string | null;
  failure_stage: string | null;
  first_terminal_truth_preserved: true;
  results: AggregatedSubtaskResult[];
}

function normalizeStatus(value: string): CanonicalEffectiveFinalStatus | null {
  const normalized = value.trim().toLowerCase();
  if (["succeeded", "success", "completed", "complete", "passed"].includes(normalized)) return "succeeded";
  if (["failed", "failure", "error", "no_fix_applied", "read_only_violation"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["blocked", "blocked_dependency"].includes(normalized)) return "blocked";
  return null;
}

function canonicalEffectiveStatus(result: CanonicalSubtaskResult): CanonicalEffectiveFinalStatus {
  const taskStatus = normalizeStatus(result.task_goal_status);
  const effectiveStatus = normalizeStatus(result.effective_final_status);
  const workerStatus = normalizeStatus(result.worker_status);
  if (taskStatus === "failed" || taskStatus === "blocked" || taskStatus === "cancelled") return taskStatus;
  if (effectiveStatus) return effectiveStatus;
  if (workerStatus === "failed" || workerStatus === "cancelled") return workerStatus;
  if (workerStatus === "succeeded" && taskStatus === "succeeded") return "succeeded";
  throw new Error(`NON_TERMINAL_CANONICAL_RESULT:${result.subtask_id}`);
}

function firstTerminalResults(jobResults: CanonicalSubtaskResult[]): Map<string, AggregatedSubtaskResult> {
  const selected = new Map<string, AggregatedSubtaskResult>();
  const duplicateCounts = new Map<string, number>();
  for (const result of jobResults) {
    if (selected.has(result.subtask_id)) {
      duplicateCounts.set(result.subtask_id, (duplicateCounts.get(result.subtask_id) ?? 0) + 1);
      continue;
    }
    selected.set(result.subtask_id, {
      ...result,
      effective_final_status: canonicalEffectiveStatus(result),
      duplicate_terminal_reports_ignored: 0,
      synthetic: false,
    });
  }
  for (const [subtaskId, count] of duplicateCounts) {
    const result = selected.get(subtaskId);
    if (result) result.duplicate_terminal_reports_ignored = count;
  }
  return selected;
}

function aggregationStatus(results: AggregatedSubtaskResult[]): HermesAggregationStatus {
  const statuses = new Set(results.map((result) => result.effective_final_status));
  if (statuses.size === 1 && statuses.has("succeeded")) return "all_success";
  if (statuses.size === 1 && statuses.has("cancelled")) return "cancelled";
  if (statuses.has("blocked")) return "blocked_dependency";
  if (statuses.has("failed") && statuses.has("succeeded")) return "partial_failure";
  if (statuses.size > 1) return "mixed_terminal_results";
  return "partial_failure";
}

export function aggregatePlanResults(input: {
  plan: HermesExecutionPlan;
  job_results: CanonicalSubtaskResult[];
}): HermesPlanAggregate {
  const planIds = new Set(input.plan.subtasks.map((subtask) => subtask.subtask_id));
  const unknownResult = input.job_results.find((result) => !planIds.has(result.subtask_id));
  if (unknownResult) throw new Error(`UNKNOWN_SUBTASK_RESULT:${unknownResult.subtask_id}`);

  const selected = firstTerminalResults(input.job_results);
  for (const subtask of input.plan.subtasks) {
    if (selected.has(subtask.subtask_id)) continue;
    const blockingDependency = subtask.dependencies.find((dependency) => {
      const result = selected.get(dependency);
      return result && result.effective_final_status !== "succeeded";
    });
    selected.set(subtask.subtask_id, {
      subtask_id: subtask.subtask_id,
      report_identity: `synthetic:${input.plan.plan_id}:${subtask.subtask_id}`,
      worker_status: "not_started",
      task_goal_status: blockingDependency ? "blocked_dependency" : "failed",
      effective_final_status: blockingDependency ? "blocked" : "failed",
      failure_code: blockingDependency ? "DEPENDENCY_TERMINAL_FAILURE" : "SUBTASK_RESULT_MISSING",
      failure_stage: "hermes_result_aggregation",
      duplicate_terminal_reports_ignored: 0,
      synthetic: true,
    });
  }

  const results = input.plan.subtasks.map((subtask) => selected.get(subtask.subtask_id)!);
  const status = aggregationStatus(results);
  const firstFailure = results.find((result) => result.effective_final_status !== "succeeded");
  const effectiveFinalStatus = status === "all_success" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";

  return {
    plan_id: input.plan.plan_id,
    plan_hash: input.plan.plan_hash,
    aggregation_status: status,
    worker_status: status === "all_success" ? "succeeded" : "mixed",
    task_goal_status: effectiveFinalStatus,
    effective_final_status: effectiveFinalStatus,
    failure_code: firstFailure?.failure_code ?? null,
    failure_stage: firstFailure?.failure_stage ?? null,
    first_terminal_truth_preserved: true,
    results,
  };
}
