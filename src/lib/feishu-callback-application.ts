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

export type FeishuCallbackAcceptance =
  | { ok: true; accepted: AcceptedFeishuCallback }
  | { ok: false; status: 400 | 401 | 503; failure_code: string };

export interface FeishuCallbackAuthenticationAuditRecord {
  failure_code: string;
  authentication_layer: "GATEWAY_APPLICATION" | "FEISHU_CALLBACK" | "CALLBACK_PAYLOAD" | "ACCEPTED";
  authentication_stage: string;
  internal_gateway_auth_passed: boolean;
  feishu_callback_auth_passed: boolean;
}

const FAILURE_AUDIT: Record<string, Omit<FeishuCallbackAuthenticationAuditRecord, "failure_code">> = {
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
  FEISHU_CALLBACK_TOKEN_INVALID: {
    authentication_layer: "FEISHU_CALLBACK",
    authentication_stage: "VERIFICATION_TOKEN",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: false,
  },
  FEISHU_CALLBACK_BODY_INVALID: {
    authentication_layer: "CALLBACK_PAYLOAD",
    authentication_stage: "BODY_PARSE",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: true,
  },
  FEISHU_CALLBACK_DECRYPT_FAILED: {
    authentication_layer: "CALLBACK_PAYLOAD",
    authentication_stage: "DECRYPTION",
    internal_gateway_auth_passed: true,
    feishu_callback_auth_passed: true,
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
    };
  }
  const audit = FAILURE_AUDIT[acceptance.failure_code];
  return {
    failure_code: acceptance.failure_code,
    authentication_layer: audit?.authentication_layer ?? "CALLBACK_PAYLOAD",
    authentication_stage: audit?.authentication_stage ?? "UNKNOWN",
    internal_gateway_auth_passed: audit?.internal_gateway_auth_passed ?? false,
    feishu_callback_auth_passed: audit?.feishu_callback_auth_passed ?? false,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

export function prepareFeishuCallbackAcceptance(input: {
  rawBody: Uint8Array;
  headers: Headers;
  env: Record<string, string | undefined>;
}): FeishuCallbackAcceptance {
  const applicationSecret = stringValue(input.env.FEISHU_APP_SECRET);
  const encryptKey = stringValue(input.env.FEISHU_ENCRYPT_KEY);
  if (!applicationSecret) {
    return { ok: false, status: 503, failure_code: "FEISHU_APPLICATION_AUTH_SECRET_MISSING" };
  }
  if (!encryptKey) {
    return { ok: false, status: 503, failure_code: "FEISHU_CALLBACK_ENCRYPT_KEY_MISSING" };
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

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
  } catch {
    return { ok: false, status: 400, failure_code: "FEISHU_CALLBACK_BODY_INVALID" };
  }

  let payload: Record<string, unknown> = body;
  const encryptedBody = stringValue(body.encrypt);
  if (encryptedBody) {
    try {
      payload = JSON.parse(decryptFeishuEvent(encryptedBody, encryptKey));
    } catch {
      return { ok: false, status: 400, failure_code: "FEISHU_CALLBACK_DECRYPT_FAILED" };
    }
  }

  const verificationToken = stringValue(input.env.FEISHU_VERIFICATION_TOKEN);
  if (verificationToken && stringValue(payload.token) !== verificationToken) {
    return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_TOKEN_INVALID" };
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
