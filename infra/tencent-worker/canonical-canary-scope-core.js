/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("crypto");

const ENV = Object.freeze({
  globalOrchestration: "HERMES_CANONICAL_ORCHESTRATION_ENABLED",
  globalPersistence: "CANONICAL_DATABASE_PERSISTENCE_ENABLED",
  scopeEnabled: "HERMES_CANONICAL_CANARY_SCOPE_ENABLED",
  durableAdmissionEnabled: "HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED",
  allowedOwnerIds: "HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS",
  allowedBatchCodes: "HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES",
  allowedModes: "HERMES_CANONICAL_CANARY_ALLOWED_MODES",
  policyId: "HERMES_CANONICAL_CANARY_POLICY_ID",
});

const OWNER_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const BATCH_PATTERN = /^BATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const POLICY_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,127}$/;
const CANARY_MODE = "worker_read_only";
const AUDITABLE_MODES = new Set(["worker_read_only", "manager_read_only", "write_allowed"]);
const POLICY_CORRELATION_SOURCE = "SERVER_SIDE_CONFIG_CANDIDATE";
const DENY_REASON_CODES = Object.freeze([
  "GLOBAL_CANONICAL_DISABLED",
  "MISSING_CONFIGURATION",
  "MALFORMED_CONFIGURATION",
  "CANARY_SCOPE_DISABLED",
  "DURABLE_ADMISSION_DISABLED",
  "EMPTY_OWNER_ALLOWLIST",
  "EMPTY_BATCH_ALLOWLIST",
  "EMPTY_MODE_ALLOWLIST",
  "GLOBAL_PERSISTENCE_DISABLED",
  "OWNER_NOT_ALLOWED",
  "BATCH_NOT_ALLOWED",
  "MODE_NOT_ALLOWED",
  "POLICY_MISMATCH",
  "ADMISSION_IDENTITY_INCOMPLETE",
  "DURABLE_ADMISSION_REJECTED",
  "CANARY_ALREADY_CONSUMED",
  "CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN",
]);

function strictTrue(value) {
  return value === "true";
}

function parseExactList(value, validator) {
  if (typeof value !== "string" || !value) return { ok: false, values: [] };
  const values = value.split(",");
  if (
    values.length === 0 ||
    values.some((item) => !item || item !== item.trim() || !validator(item)) ||
    new Set(values).size !== values.length
  ) {
    return { ok: false, values: [] };
  }
  return { ok: true, values };
}

function hashAuditValue(value, length = 16) {
  return typeof value === "string" && value
    ? crypto.createHash("sha256").update(value).digest("hex").slice(0, length)
    : null;
}

function configSlotFingerprint(value) {
  if (typeof value !== "string") return Object.freeze({ state: "missing" });
  if (!value) return Object.freeze({ state: "empty" });
  return Object.freeze({ state: "present", value_hash: hashAuditValue(value, 32) });
}

function buildCanonicalCanaryPolicyAuditContext(env = process.env) {
  const descriptor = {
    contract: "canonical_canary_policy_config_v1",
    scope_enabled: configSlotFingerprint(env[ENV.scopeEnabled]),
    durable_admission_enabled: configSlotFingerprint(env[ENV.durableAdmissionEnabled]),
    owner_allowlist: configSlotFingerprint(env[ENV.allowedOwnerIds]),
    batch_allowlist: configSlotFingerprint(env[ENV.allowedBatchCodes]),
    mode_allowlist: configSlotFingerprint(env[ENV.allowedModes]),
    policy_id: configSlotFingerprint(env[ENV.policyId]),
  };
  return Object.freeze({
    policy_correlation_source: POLICY_CORRELATION_SOURCE,
    policy_correlation_hash: hashAuditValue(JSON.stringify(descriptor), 32),
  });
}

function buildCanonicalCanaryCandidateAuditContext(input = {}, env = process.env) {
  const requestedMode = typeof input.requested_mode === "string" ? input.requested_mode : null;
  return Object.freeze({
    owner_id_hash: hashAuditValue(input.trusted_owner_id),
    batch_code_hash: hashAuditValue(input.batch_code),
    requested_mode: requestedMode && AUDITABLE_MODES.has(requestedMode) ? requestedMode : requestedMode ? "unrecognized" : null,
    requested_mode_hash: hashAuditValue(requestedMode),
    event_id_hash: hashAuditValue(input.event_id),
    request_id_hash: hashAuditValue(input.request_id),
    ...buildCanonicalCanaryPolicyAuditContext(env),
  });
}

function validPolicyId(value) {
  return typeof value === "string" && POLICY_PATTERN.test(value) ? value : null;
}

function resolveCanonicalCanaryScopeConfig(env = process.env) {
  const policyId = validPolicyId(env[ENV.policyId]);
  const scopeEnabled = env[ENV.scopeEnabled];
  if (typeof scopeEnabled !== "string") {
    return { ok: false, reason_code: "MISSING_CONFIGURATION", policy_id: policyId };
  }
  if (scopeEnabled !== "true" && scopeEnabled !== "false") {
    return { ok: false, reason_code: "MALFORMED_CONFIGURATION", policy_id: policyId };
  }
  if (!strictTrue(scopeEnabled)) {
    return { ok: false, reason_code: "CANARY_SCOPE_DISABLED", policy_id: policyId };
  }

  const requiredValues = [
    env[ENV.durableAdmissionEnabled],
    env[ENV.allowedOwnerIds],
    env[ENV.allowedBatchCodes],
    env[ENV.allowedModes],
    env[ENV.policyId],
  ];
  if (requiredValues.some((value) => typeof value !== "string")) {
    return { ok: false, reason_code: "MISSING_CONFIGURATION", policy_id: policyId };
  }

  const durableAdmissionEnabled = env[ENV.durableAdmissionEnabled];
  if (durableAdmissionEnabled !== "true" && durableAdmissionEnabled !== "false") {
    return { ok: false, reason_code: "MALFORMED_CONFIGURATION", policy_id: policyId };
  }
  if (!strictTrue(durableAdmissionEnabled)) {
    return { ok: false, reason_code: "DURABLE_ADMISSION_DISABLED", policy_id: policyId };
  }

  if (env[ENV.allowedOwnerIds] === "") {
    return { ok: false, reason_code: "EMPTY_OWNER_ALLOWLIST", policy_id: policyId };
  }
  if (env[ENV.allowedBatchCodes] === "") {
    return { ok: false, reason_code: "EMPTY_BATCH_ALLOWLIST", policy_id: policyId };
  }
  if (env[ENV.allowedModes] === "") {
    return { ok: false, reason_code: "EMPTY_MODE_ALLOWLIST", policy_id: policyId };
  }
  const owners = parseExactList(env[ENV.allowedOwnerIds], (value) => OWNER_PATTERN.test(value));
  const batches = parseExactList(env[ENV.allowedBatchCodes], (value) => BATCH_PATTERN.test(value));
  const modes = parseExactList(env[ENV.allowedModes], (value) => value === CANARY_MODE);
  if (!owners.ok || !batches.ok || !modes.ok || !policyId) {
    return { ok: false, reason_code: "MALFORMED_CONFIGURATION", policy_id: policyId };
  }

  return {
    ok: true,
    reason_code: "POLICY_VALID",
    policy_id: policyId,
    allowed_owner_ids: owners.values,
    allowed_batch_codes: batches.values,
    allowed_modes: modes.values,
  };
}

function denied(reasonCode, config, auditContext, matches = {}) {
  return {
    allowed: false,
    reason_code: reasonCode,
    policy_id: config && config.policy_id || null,
    trusted_owner_match: matches.trusted_owner_match === true,
    batch_match: matches.batch_match === true,
    mode_match: matches.mode_match === true,
    one_shot_available: false,
    admission: null,
    audit_context: auditContext,
  };
}

function evaluateCanonicalCanaryAdmission(input, env = process.env) {
  const auditContext = buildCanonicalCanaryCandidateAuditContext(input, env);
  const policyIdentity = { policy_id: validPolicyId(env[ENV.policyId]) };
  if (!strictTrue(env[ENV.globalOrchestration])) {
    return denied("GLOBAL_CANONICAL_DISABLED", policyIdentity, auditContext);
  }
  const config = resolveCanonicalCanaryScopeConfig(env);
  if (!config.ok) return denied(config.reason_code, config, auditContext);
  if (!strictTrue(env[ENV.globalPersistence])) {
    return denied("GLOBAL_PERSISTENCE_DISABLED", config, auditContext);
  }
  if (input.expected_policy_id && input.expected_policy_id !== config.policy_id) {
    return denied("POLICY_MISMATCH", config, auditContext);
  }

  const ownerMatch = typeof input.trusted_owner_id === "string" && config.allowed_owner_ids.includes(input.trusted_owner_id);
  const batchMatch = typeof input.batch_code === "string" && config.allowed_batch_codes.includes(input.batch_code);
  const modeMatch = input.requested_mode === CANARY_MODE && config.allowed_modes.includes(input.requested_mode);
  const matches = {
    trusted_owner_match: ownerMatch,
    batch_match: batchMatch,
    mode_match: modeMatch,
  };
  if (!ownerMatch) return denied("OWNER_NOT_ALLOWED", config, auditContext, matches);
  if (!batchMatch) return denied("BATCH_NOT_ALLOWED", config, auditContext, matches);
  if (!modeMatch) return denied("MODE_NOT_ALLOWED", config, auditContext, matches);
  if (typeof input.event_id !== "string" || !input.event_id || typeof input.request_id !== "string" || !input.request_id) {
    return denied("ADMISSION_IDENTITY_INCOMPLETE", config, auditContext, matches);
  }

  const admission = Object.freeze({
    policy_id: config.policy_id,
    policy_correlation_hash: auditContext.policy_correlation_hash,
    trusted_owner_id: input.trusted_owner_id,
    batch_code: input.batch_code,
    requested_mode: input.requested_mode,
    event_id: input.event_id,
    request_id: input.request_id,
  });
  return {
    allowed: true,
    reason_code: "ALLOW",
    policy_id: config.policy_id,
    trusted_owner_match: true,
    batch_match: true,
    mode_match: true,
    one_shot_available: true,
    admission,
    audit_context: auditContext,
  };
}

function buildCanonicalCanaryAuditRecord(decision) {
  const auditContext = decision && decision.audit_context || buildCanonicalCanaryCandidateAuditContext(decision && decision.admission || {});
  return {
    event: "canonical_canary_admission",
    allowed: decision && decision.allowed === true,
    reason_code: decision && decision.reason_code || "INVALID_DECISION",
    policy_id: decision && decision.policy_id || null,
    ...auditContext,
  };
}

function buildCanonicalCanaryPersistenceAuditRecord(admission, outcome = {}) {
  const policyCorrelationHash = admission && typeof admission.policy_correlation_hash === "string"
    ? admission.policy_correlation_hash
    : hashAuditValue(JSON.stringify({
      contract: "canonical_canary_admission_evidence_v1",
      policy_id: configSlotFingerprint(admission && admission.policy_id),
      owner_id: configSlotFingerprint(admission && admission.trusted_owner_id),
      batch_code: configSlotFingerprint(admission && admission.batch_code),
      requested_mode: configSlotFingerprint(admission && admission.requested_mode),
    }), 32);
  return {
    event: "canonical_canary_persistence_admission",
    allowed: outcome.allowed === true,
    reason_code: outcome.reason_code || "DURABLE_ADMISSION_REJECTED",
    policy_id: admission && admission.policy_id || null,
    ...buildCanonicalCanaryCandidateAuditContext(admission || {}, {}),
    policy_correlation_source: POLICY_CORRELATION_SOURCE,
    policy_correlation_hash: policyCorrelationHash,
  };
}

module.exports = {
  CANONICAL_CANARY_ENV: ENV,
  CANONICAL_CANARY_MODE: CANARY_MODE,
  CANONICAL_CANARY_DENY_REASON_CODES: DENY_REASON_CODES,
  CANONICAL_CANARY_POLICY_CORRELATION_SOURCE: POLICY_CORRELATION_SOURCE,
  resolveCanonicalCanaryScopeConfig,
  evaluateCanonicalCanaryAdmission,
  buildCanonicalCanaryPolicyAuditContext,
  buildCanonicalCanaryCandidateAuditContext,
  buildCanonicalCanaryAuditRecord,
  buildCanonicalCanaryPersistenceAuditRecord,
};
