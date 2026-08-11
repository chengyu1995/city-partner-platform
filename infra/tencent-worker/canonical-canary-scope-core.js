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

function hashAuditValue(value) {
  return typeof value === "string" && value
    ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
    : null;
}

function buildCanonicalCanaryCandidateAuditContext(input = {}) {
  const requestedMode = typeof input.requested_mode === "string" ? input.requested_mode : null;
  return Object.freeze({
    owner_id_hash: hashAuditValue(input.trusted_owner_id),
    batch_code_hash: hashAuditValue(input.batch_code),
    requested_mode: requestedMode && AUDITABLE_MODES.has(requestedMode) ? requestedMode : requestedMode ? "unrecognized" : null,
    requested_mode_hash: hashAuditValue(requestedMode),
    event_id_hash: hashAuditValue(input.event_id),
    request_id_hash: hashAuditValue(input.request_id),
  });
}

function resolveCanonicalCanaryScopeConfig(env = process.env) {
  if (!strictTrue(env[ENV.scopeEnabled])) {
    return { ok: false, reason_code: "CANARY_SCOPE_DISABLED" };
  }
  if (!strictTrue(env[ENV.durableAdmissionEnabled])) {
    return { ok: false, reason_code: "DURABLE_ADMISSION_DISABLED" };
  }

  const owners = parseExactList(env[ENV.allowedOwnerIds], (value) => OWNER_PATTERN.test(value));
  const batches = parseExactList(env[ENV.allowedBatchCodes], (value) => BATCH_PATTERN.test(value));
  const modes = parseExactList(env[ENV.allowedModes], (value) => value === CANARY_MODE);
  const policyId = env[ENV.policyId];
  if (!owners.ok || !batches.ok || !modes.ok || typeof policyId !== "string" || !POLICY_PATTERN.test(policyId)) {
    return { ok: false, reason_code: "MALFORMED_POLICY" };
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
    policy_id: config && config.ok ? config.policy_id : null,
    trusted_owner_match: matches.trusted_owner_match === true,
    batch_match: matches.batch_match === true,
    mode_match: matches.mode_match === true,
    one_shot_available: false,
    admission: null,
    audit_context: auditContext,
  };
}

function evaluateCanonicalCanaryAdmission(input, env = process.env) {
  const auditContext = buildCanonicalCanaryCandidateAuditContext(input);
  if (!strictTrue(env[ENV.globalOrchestration])) {
    return denied("GLOBAL_CANONICAL_DISABLED", null, auditContext);
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
  return {
    event: "canonical_canary_persistence_admission",
    allowed: outcome.allowed === true,
    reason_code: outcome.reason_code || "INVALID_PERSISTENCE_DECISION",
    policy_id: admission && admission.policy_id || null,
    ...buildCanonicalCanaryCandidateAuditContext(admission || {}),
  };
}

module.exports = {
  CANONICAL_CANARY_ENV: ENV,
  CANONICAL_CANARY_MODE: CANARY_MODE,
  resolveCanonicalCanaryScopeConfig,
  evaluateCanonicalCanaryAdmission,
  buildCanonicalCanaryCandidateAuditContext,
  buildCanonicalCanaryAuditRecord,
  buildCanonicalCanaryPersistenceAuditRecord,
};
