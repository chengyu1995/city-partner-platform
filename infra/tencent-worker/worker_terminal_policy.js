"use strict";

const TERMINAL_WORKER_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "completed",
  "reported",
  "superseded",
]);

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTerminalWorkerStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TERMINAL_WORKER_STATUSES.has(normalized) ? normalized : null;
}

function readBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (/^(?:true|1|yes|on)$/i.test(value.trim())) return true;
  if (/^(?:false|0|no|off)$/i.test(value.trim())) return false;
  return null;
}

function getTerminalWorkerJobDescriptor(job) {
  if (!job || typeof job !== "object") return null;

  const payload = asRecord(job.payload || job.metadata || job.task_payload);
  const result = asRecord(job.result);
  const canonical = asRecord(result.canonical_worker_report);
  const projectDirectorReport = asRecord(result.project_director_report);
  const candidates = [
    ["status", job.status || job.state],
    ["result.terminal_state", result.terminal_state],
    ["payload.terminal_state", payload.terminal_state],
    ["effective_final_status", job.effective_final_status],
    ["result.effective_final_status", result.effective_final_status],
    ["canonical.effective_final_status", canonical.effective_final_status],
    ["project_director_report.effective_final_status", projectDirectorReport.effective_final_status],
    ["result.final_report_status", result.final_report_status],
    ["canonical.final_report_status", canonical.final_report_status],
  ];

  for (const [source, value] of candidates) {
    const terminalState = normalizeTerminalWorkerStatus(value);
    if (!terminalState) continue;
    return {
      terminalState,
      storageStatus:
        source === "status"
          ? terminalState
          : ["succeeded", "completed", "reported"].includes(terminalState)
            ? "completed"
            : "failed",
      closureCode: null,
      source,
    };
  }

  const terminalReportAcknowledged = [
    job.terminal_report_acknowledged,
    result.terminal_report_acknowledged,
    canonical.terminal_report_acknowledged,
  ].some((value) => readBoolean(value) === true);
  if (terminalReportAcknowledged || job.finished_at || job.completed_at || job.reported_at) {
    return {
      terminalState: "completed",
      storageStatus: "completed",
      closureCode: null,
      source: terminalReportAcknowledged ? "terminal_report_acknowledged" : "terminal_timestamp",
    };
  }

  return null;
}

function isTerminalWorkerJob(job) {
  return Boolean(getTerminalWorkerJobDescriptor(job));
}

module.exports = {
  TERMINAL_WORKER_STATUSES,
  getTerminalWorkerJobDescriptor,
  isTerminalWorkerJob,
  normalizeTerminalWorkerStatus,
};
