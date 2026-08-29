export const WORKER_REQUESTED_MODE_ALLOWLIST_ENV =
  "HERMES_WORKER_ALLOWED_REQUESTED_MODES";

export const WORKER_REQUESTED_MODES = [
  "manager_read_only",
  "worker_read_only",
  "write_allowed",
] as const;

export type WorkerRequestedMode = (typeof WORKER_REQUESTED_MODES)[number];

export type WorkerRequestedModePolicyReason =
  | "LEGACY_COMPATIBILITY"
  | "ALLOWLIST_ENFORCED"
  | "EMPTY_ALLOWLIST"
  | "MALFORMED_ALLOWLIST";

export interface WorkerRequestedModeAdmissionPolicy {
  configured: boolean;
  enforced: boolean;
  valid: boolean;
  reason_code: WorkerRequestedModePolicyReason;
  allowed_modes: readonly WorkerRequestedMode[];
}

const MODE_SET = new Set<string>(WORKER_REQUESTED_MODES);

export function resolveWorkerRequestedModeAdmissionPolicy(
  env: Record<string, string | undefined> = process.env
): WorkerRequestedModeAdmissionPolicy {
  const raw = env[WORKER_REQUESTED_MODE_ALLOWLIST_ENV];
  if (raw === undefined) {
    return {
      configured: false,
      enforced: false,
      valid: true,
      reason_code: "LEGACY_COMPATIBILITY",
      allowed_modes: [],
    };
  }
  if (raw === "") {
    return {
      configured: true,
      enforced: true,
      valid: false,
      reason_code: "EMPTY_ALLOWLIST",
      allowed_modes: [],
    };
  }

  const values = raw.split(",");
  const uniqueValues = new Set(values);
  const malformed =
    values.some((value) => !MODE_SET.has(value)) ||
    uniqueValues.size !== values.length;
  if (malformed) {
    return {
      configured: true,
      enforced: true,
      valid: false,
      reason_code: "MALFORMED_ALLOWLIST",
      allowed_modes: [],
    };
  }

  return {
    configured: true,
    enforced: true,
    valid: true,
    reason_code: "ALLOWLIST_ENFORCED",
    allowed_modes: values as WorkerRequestedMode[],
  };
}

export function readWorkerRequestedMode(
  job: Record<string, unknown> | null | undefined
): string | null {
  const value = job?.requested_mode;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function workerRequestedModeAllowed(
  job: Record<string, unknown> | null | undefined,
  policy: WorkerRequestedModeAdmissionPolicy
): boolean {
  if (!policy.enforced) return true;
  if (!policy.valid) return false;
  const requestedMode = readWorkerRequestedMode(job);
  return requestedMode !== null && policy.allowed_modes.includes(requestedMode as WorkerRequestedMode);
}
