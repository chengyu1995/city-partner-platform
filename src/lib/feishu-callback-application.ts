import { createHash, timingSafeEqual } from "node:crypto";
import { decryptFeishuEvent } from "@/lib/feishu-crypto";
import {
  FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER,
  FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER,
  FEISHU_APPLICATION_BOUNDARY_SOURCE_ID,
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  FEISHU_TIMESTAMP_HEADER,
  FEISHU_TRANSPORT_REQUEST_ID_HEADER,
  verifyFeishuApplicationBoundaryRequest,
  verifyFeishuCallbackRequestSignature,
} from "@/lib/feishu-canonical-gateway-envelope";

export interface AcceptedFeishuCallback {
  payload: Record<string, unknown>;
  event_id: string;
  event_type: string;
  transport_request_id: string;
}

export type FeishuVerificationTokenSource = "HEADER_V2" | "ROOT_V1" | "NONE" | "CONFLICT";

interface FeishuVerificationTokenAuditContext {
  token_present: boolean;
  token_source: FeishuVerificationTokenSource;
  runtime_token_present: boolean;
  constant_time_compare_result: boolean | null;
}

export type FeishuCallbackAcceptance =
  | { ok: true; accepted: AcceptedFeishuCallback }
  | {
      ok: false;
      status: 400 | 401 | 503;
      failure_code: string;
      verification_token_audit?: FeishuVerificationTokenAuditContext;
    };

export interface FeishuCallbackAuthenticationAuditRecord {
  failure_code: string;
  authentication_layer: "GATEWAY_APPLICATION" | "FEISHU_CALLBACK" | "CALLBACK_PAYLOAD" | "ACCEPTED";
  authentication_stage: string;
  internal_gateway_auth_passed: boolean;
  feishu_callback_auth_passed: boolean;
  token_present: boolean;
  token_source: FeishuVerificationTokenSource;
  runtime_token_present: boolean;
  constant_time_compare_result: boolean | null;
}

export const FEISHU_CALLBACK_MODE_ENCRYPTED_SIGNATURE = "encrypted_signature";
export const FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN = "unencrypted_verification_token";

type FeishuCallbackMode =
  | typeof FEISHU_CALLBACK_MODE_ENCRYPTED_SIGNATURE
  | typeof FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN;

const FAILURE_AUDIT: Record<
  string,
  Pick<
    FeishuCallbackAuthenticationAuditRecord,
    "authentication_layer" | "authentication_stage" | "internal_gateway_auth_passed" | "feishu_callback_auth_passed"
  >
> = {
  FEISHU_APPLICATION_AUTH_SECRET_MISSING: {
    authentication_layer: "GATEWAY_APPLICATION",
    authentication_stage: "HMAC_SECRET_CONFIGURATION",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_ENCRYPT_KEY_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "ENCRYPT_KEY_CONFIGURATION",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_MODE_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "MODE_CONFIGURATION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_MODE_INVALID: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "MODE_CONFIGURATION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TOKEN_RUNTIME_CONFIG_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN_CONFIGURATION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_MODE_PAYLOAD_MISMATCH: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "MODE_PAYLOAD_BINDING",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_APPLICATION_BOUNDARY_SOURCE_MISSING: {
    authentication_layer: "GATEWAY_APPLICATION",
    authentication_stage: "SOURCE_HEADER",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_APPLICATION_BOUNDARY_SIGNATURE_MISSING: {
    authentication_layer: "GATEWAY_APPLICATION",
    authentication_stage: "HMAC_HEADER",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_APPLICATION_BOUNDARY_SOURCE_INVALID: {
    authentication_layer: "GATEWAY_APPLICATION",
    authentication_stage: "SOURCE_VALUE",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_APPLICATION_BOUNDARY_SIGNATURE_INVALID: {
    authentication_layer: "GATEWAY_APPLICATION",
    authentication_stage: "HMAC_VERIFICATION",
    internal_gateway_auth_passed: false,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TIMESTAMP_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "TIMESTAMP_HEADER",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_NONCE_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "NONCE_HEADER",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_SIGNATURE_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "SIGNATURE_HEADER",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_SIGNATURE_INVALID: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "SIGNATURE_VERIFICATION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TOKEN_MISSING: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN_MISSING",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TOKEN_SOURCE_INVALID: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN_SOURCE",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TOKEN_CONFLICT: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN_CONFLICT",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_TOKEN_MISMATCH: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN_COMPARISON",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_BODY_INVALID: {
    authentication_layer: "CALLBACK_PAYLOAD",
    authentication_stage: "BODY_PARSE",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_DECRYPT_FAILED: {
    authentication_layer: "CALLBACK_PAYLOAD",
    authentication_stage: "DECRYPTION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_IDENTITY_INCOMPLETE: {
    authentication_layer: "CALLBACK_PAYLOAD",
    authentication_stage: "EVENT_IDENTITY",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: true,
  },
};

export function buildFeishuCallbackAuthenticationAuditRecord(
  acceptance: FeishuCallbackAcceptance
): FeishuCallbackAuthenticationAuditRecord {
  if (acceptance.ok) {
    return {
      failure_code: "NONE",
      authentication_layer: "ACCEPTED",
      authentication_stage: "COMPLETE",
      internal_gateway_auth_passed: true,
      feishu_callback_auth_passed: true,
      token_present: false,
      token_source: "NONE",
      runtime_token_present: false,
      constant_time_compare_result: null,
    };
  }
  const audit = FAILURE_AUDIT[acceptance.failure_code];
  return {
    failure_code: acceptance.failure_code,
    authentication_layer: audit?.authentication_layer ?? "CALLBACK_PAYLOAD",
    authentication_stage: audit?.authentication_stage ?? "UNKNOWN",
    internal_gateway_auth_passed: audit?.internal_gateway_auth_passed ?? false,
    feishu_callback_auth_passed: audit?.feishu_callback_auth_passed ?? false,
    token_present: acceptance.verification_token_audit?.token_present ?? false,
    token_source: acceptance.verification_token_audit?.token_source ?? "NONE",
    runtime_token_present: acceptance.verification_token_audit?.runtime_token_present ?? false,
    constant_time_compare_result: acceptance.verification_token_audit?.constant_time_compare_result ?? null,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function literalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function callbackMode(value: unknown): FeishuCallbackMode | null {
  const mode = stringValue(value);
  if (
    mode === FEISHU_CALLBACK_MODE_ENCRYPTED_SIGNATURE
    || mode === FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN
  ) {
    return mode;
  }
  return null;
}

function constantTimeStringEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedDigest = createHash("sha256").update(expectedBytes).digest();
  const actualDigest = createHash("sha256").update(actualBytes).digest();
  return timingSafeEqual(expectedDigest, actualDigest) && expectedBytes.length === actualBytes.length;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function callbackIdentity(payload: Record<string, unknown>): { eventId: string; eventType: string } {
  const event = nestedRecord(payload.event);
  const header = nestedRecord(payload.header);
  const eventHeader = nestedRecord(event.header);
  return {
    eventId: stringValue(
      header.event_id || eventHeader.event_id || payload.event_id
    ),
    eventType: stringValue(
      header.event_type || eventHeader.event_type || payload.event_type || payload.type
    ),
  };
}

interface CallbackVerificationTokenResolution {
  value: string;
  source: FeishuVerificationTokenSource;
  source_valid: boolean;
}

function verificationTokenAudit(
  resolution: CallbackVerificationTokenResolution,
  runtimeTokenPresent: boolean,
  constantTimeCompareResult: boolean | null
): FeishuVerificationTokenAuditContext {
  return {
    token_present: resolution.source !== "NONE",
    token_source: resolution.source,
    runtime_token_present: runtimeTokenPresent,
    constant_time_compare_result: constantTimeCompareResult,
  };
}

function callbackVerificationToken(payload: Record<string, unknown>): CallbackVerificationTokenResolution {
  const rootToken = literalString(payload.token);
  const header = nestedRecord(payload.header);
  const headerToken = literalString(header.token);
  if (rootToken && headerToken && !constantTimeStringEqual(rootToken, headerToken)) {
    return { value: "", source: "CONFLICT", source_valid: false };
  }
  const isV2 = literalString(payload.schema) === "2.0";
  if (isV2) {
    if (headerToken) return { value: headerToken, source: "HEADER_V2", source_valid: true };
    if (rootToken) return { value: rootToken, source: "ROOT_V1", source_valid: false };
    return { value: "", source: "NONE", source_valid: true };
  }
  if (rootToken) return { value: rootToken, source: "ROOT_V1", source_valid: true };
  if (headerToken) return { value: headerToken, source: "HEADER_V2", source_valid: false };
  return { value: "", source: "NONE", source_valid: true };
}

export function prepareFeishuCallbackAcceptance(input: {
  rawBody: Uint8Array;
  headers: Headers;
  env: Record<string, string | undefined>;
}): FeishuCallbackAcceptance {
  const applicationSecret = stringValue(input.env.FEISHU_APP_SECRET);
  if (!applicationSecret) {
    return { ok: false, status: 503, failure_code: "FEISHU_APPLICATION_AUTH_SECRET_MISSING" };
  }

  const boundarySource = input.headers.get(FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER);
  const boundarySignature = input.headers.get(FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER);
  if (!boundarySource) {
    return { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SOURCE_MISSING" };
  }
  if (!boundarySignature) {
    return { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SIGNATURE_MISSING" };
  }
  if (boundarySource !== FEISHU_APPLICATION_BOUNDARY_SOURCE_ID) {
    return { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SOURCE_INVALID" };
  }

  const boundaryVerified = verifyFeishuApplicationBoundaryRequest({
    rawBody: input.rawBody,
    signature: boundarySignature,
    source: boundarySource,
    secret: applicationSecret,
  });
  if (!boundaryVerified) {
    return { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SIGNATURE_INVALID" };
  }

  const configuredMode = stringValue(input.env.FEISHU_CALLBACK_ENCRYPTION_MODE);
  const mode = callbackMode(configuredMode);
  if (!configuredMode) {
    return { ok: false, status: 503, failure_code: "FEISHU_CALLBACK_MODE_MISSING" };
  }
  if (!mode) {
    return { ok: false, status: 503, failure_code: "FEISHU_CALLBACK_MODE_INVALID" };
  }

  const encryptKey = stringValue(input.env.FEISHU_ENCRYPT_KEY);
  if (mode === FEISHU_CALLBACK_MODE_ENCRYPTED_SIGNATURE) {
    if (!encryptKey) {
      return { ok: false, status: 503, failure_code: "FEISHU_CALLBACK_ENCRYPT_KEY_MISSING" };
    }
    if (!input.headers.get(FEISHU_TIMESTAMP_HEADER)) {
      return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_TIMESTAMP_MISSING" };
    }
    if (!input.headers.get(FEISHU_NONCE_HEADER)) {
      return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_NONCE_MISSING" };
    }
    if (!input.headers.get(FEISHU_SIGNATURE_HEADER)) {
      return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_SIGNATURE_MISSING" };
    }
    if (!verifyFeishuCallbackRequestSignature({
      rawBody: input.rawBody,
      headers: input.headers,
      encryptKey,
    })) {
      return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_SIGNATURE_INVALID" };
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
  } catch {
    return { ok: false, status: 400, failure_code: "FEISHU_CALLBACK_BODY_INVALID" };
  }

  let payload: Record<string, unknown> = body;
  const encryptedBody = stringValue(body.encrypt);
  if (mode === FEISHU_CALLBACK_MODE_ENCRYPTED_SIGNATURE) {
    if (encryptedBody) {
      try {
        payload = JSON.parse(decryptFeishuEvent(encryptedBody, encryptKey));
      } catch {
        return { ok: false, status: 400, failure_code: "FEISHU_CALLBACK_DECRYPT_FAILED" };
      }
    }
  } else if (encryptedBody) {
    return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_MODE_PAYLOAD_MISMATCH" };
  }

  const verificationToken = literalString(input.env.FEISHU_VERIFICATION_TOKEN);
  const tokenResolution = callbackVerificationToken(payload);
  const runtimeTokenPresent = verificationToken.length > 0;
  if (mode === FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN && !runtimeTokenPresent) {
    return {
      ok: false,
      status: 503,
      failure_code: "FEISHU_CALLBACK_TOKEN_RUNTIME_CONFIG_MISSING",
      verification_token_audit: verificationTokenAudit(tokenResolution, false, null),
    };
  }
  if (tokenResolution.source === "CONFLICT") {
    return {
      ok: false,
      status: 401,
      failure_code: "FEISHU_CALLBACK_TOKEN_CONFLICT",
      verification_token_audit: verificationTokenAudit(tokenResolution, runtimeTokenPresent, false),
    };
  }
  if (mode === FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN && tokenResolution.source === "NONE") {
    return {
      ok: false,
      status: 401,
      failure_code: "FEISHU_CALLBACK_TOKEN_MISSING",
      verification_token_audit: verificationTokenAudit(tokenResolution, runtimeTokenPresent, false),
    };
  }
  if (mode === FEISHU_CALLBACK_MODE_UNENCRYPTED_VERIFICATION_TOKEN && !tokenResolution.source_valid) {
    return {
      ok: false,
      status: 401,
      failure_code: "FEISHU_CALLBACK_TOKEN_SOURCE_INVALID",
      verification_token_audit: verificationTokenAudit(tokenResolution, runtimeTokenPresent, false),
    };
  }
  if (runtimeTokenPresent) {
    const tokenMatches = constantTimeStringEqual(verificationToken, tokenResolution.value);
    if (!tokenMatches) {
      return {
        ok: false,
        status: 401,
        failure_code: "FEISHU_CALLBACK_TOKEN_MISMATCH",
        verification_token_audit: verificationTokenAudit(tokenResolution, true, false),
      };
    }
  }

  const identity = callbackIdentity(payload);
  if (!identity.eventId || !identity.eventType) {
    return { ok: false, status: 400, failure_code: "FEISHU_CALLBACK_IDENTITY_INCOMPLETE" };
  }

  return {
    ok: true,
    accepted: {
      payload,
      event_id: identity.eventId,
      event_type: identity.eventType,
      transport_request_id: stringValue(input.headers.get(FEISHU_TRANSPORT_REQUEST_ID_HEADER)),
    },
  };
}
