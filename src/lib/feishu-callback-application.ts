import { decryptFeishuEvent } from "@/lib/feishu-crypto";
import {
  FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER,
  FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER,
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
  if (!applicationSecret || !encryptKey) {
    return { ok: false, status: 503, failure_code: "FEISHU_CALLBACK_AUTH_CONFIGURATION_MISSING" };
  }

  const boundaryVerified = verifyFeishuApplicationBoundaryRequest({
    rawBody: input.rawBody,
    signature: input.headers.get(FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER),
    source: input.headers.get(FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER),
    secret: applicationSecret,
  });
  if (!boundaryVerified) {
    return { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SIGNATURE_INVALID" };
  }

  const requiredSignatureHeaders = [
    FEISHU_TIMESTAMP_HEADER,
    FEISHU_NONCE_HEADER,
    FEISHU_SIGNATURE_HEADER,
  ];
  if (requiredSignatureHeaders.some((header) => !input.headers.get(header))) {
    return { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_SIGNATURE_CONTEXT_MISSING" };
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
