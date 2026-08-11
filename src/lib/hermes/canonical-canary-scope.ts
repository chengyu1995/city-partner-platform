import canaryCore from "../../../infra/tencent-worker/canonical-canary-scope-core.js";

export const CANONICAL_CANARY_ENV = canaryCore.CANONICAL_CANARY_ENV as Readonly<{
  globalOrchestration: string;
  globalPersistence: string;
  scopeEnabled: string;
  durableAdmissionEnabled: string;
  allowedOwnerIds: string;
  allowedBatchCodes: string;
  allowedModes: string;
  policyId: string;
}>;

export const CANONICAL_CANARY_MODE = "worker_read_only" as const;

export interface CanonicalCanaryAdmissionEvidence {
  policy_id: string;
  trusted_owner_id: string;
  batch_code: string;
  requested_mode: typeof CANONICAL_CANARY_MODE;
  event_id: string;
  request_id: string;
}

export interface CanonicalCanaryAuditContext {
  owner_id_hash: string | null;
  batch_code_hash: string | null;
  requested_mode: string | null;
  requested_mode_hash: string | null;
  event_id_hash: string | null;
  request_id_hash: string | null;
}

export interface CanonicalCanaryAdmissionDecision {
  allowed: boolean;
  reason_code: string;
  policy_id: string | null;
  trusted_owner_match: boolean;
  batch_match: boolean;
  mode_match: boolean;
  one_shot_available: boolean;
  admission: CanonicalCanaryAdmissionEvidence | null;
  audit_context: CanonicalCanaryAuditContext;
}

export interface CanonicalCanaryScopeConfig {
  ok: boolean;
  reason_code: string;
  policy_id?: string;
  allowed_owner_ids?: string[];
  allowed_batch_codes?: string[];
  allowed_modes?: string[];
}

export const resolveCanonicalCanaryScopeConfig = canaryCore.resolveCanonicalCanaryScopeConfig as (
  env?: Record<string, string | undefined>
) => CanonicalCanaryScopeConfig;

export const evaluateCanonicalCanaryAdmission = canaryCore.evaluateCanonicalCanaryAdmission as (
  input: {
    trusted_owner_id: string | null;
    batch_code: string | null;
    requested_mode: string | null;
    event_id: string;
    request_id: string;
    expected_policy_id?: string | null;
  },
  env?: Record<string, string | undefined>
) => CanonicalCanaryAdmissionDecision;

export const buildCanonicalCanaryAuditRecord = canaryCore.buildCanonicalCanaryAuditRecord as (
  decision: CanonicalCanaryAdmissionDecision
) => Record<string, unknown>;

export const buildCanonicalCanaryPersistenceAuditRecord = canaryCore.buildCanonicalCanaryPersistenceAuditRecord as (
  admission: CanonicalCanaryAdmissionEvidence,
  outcome: { allowed: boolean; reason_code: string }
) => Record<string, unknown>;

export function requireAllowedCanonicalCanaryAdmission(
  decision: CanonicalCanaryAdmissionDecision
): CanonicalCanaryAdmissionEvidence {
  if (!decision.allowed || !decision.admission) {
    throw new Error(`CANONICAL_CANARY_ADMISSION_DENIED:${decision.reason_code}`);
  }
  return decision.admission;
}
