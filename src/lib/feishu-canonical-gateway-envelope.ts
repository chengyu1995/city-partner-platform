import gatewayBoundary from "../../infra/tencent-worker/feishu_gateway_canonical_router.js";

export const FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER = gatewayBoundary.SIGNATURE_HEADER as string;
export const FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER = gatewayBoundary.SOURCE_HEADER as string;
export const FEISHU_APPLICATION_BOUNDARY_SOURCE_ID = gatewayBoundary.SOURCE_ID as string;
export const FEISHU_TRANSPORT_REQUEST_ID_HEADER = gatewayBoundary.TRANSPORT_REQUEST_ID_HEADER as string;
export const FEISHU_TIMESTAMP_HEADER = gatewayBoundary.FEISHU_TIMESTAMP_HEADER as string;
export const FEISHU_NONCE_HEADER = gatewayBoundary.FEISHU_NONCE_HEADER as string;
export const FEISHU_SIGNATURE_HEADER = gatewayBoundary.FEISHU_SIGNATURE_HEADER as string;

export type FeishuRawBody = string | Uint8Array | ArrayBuffer;

export interface FeishuApplicationAcceptanceResponse {
  code: 0;
  accepted: true;
  transport_acceptance: true;
  event_id: string;
}

export function buildFeishuApplicationAcceptanceResponse(
  eventId: string
): FeishuApplicationAcceptanceResponse {
  return gatewayBoundary.buildFeishuApplicationAcceptanceResponse(
    eventId
  ) as FeishuApplicationAcceptanceResponse;
}

export function verifyFeishuApplicationBoundaryRequest(input: {
  rawBody: FeishuRawBody;
  signature: string | null;
  source: string | null;
  secret: string;
}): boolean {
  if (input.source !== FEISHU_APPLICATION_BOUNDARY_SOURCE_ID) return false;
  return gatewayBoundary.verifyApplicationPayloadSignature(input.rawBody, input.signature, input.secret);
}

export function calculateFeishuCallbackSignature(input: {
  rawBody: FeishuRawBody;
  timestamp: string;
  nonce: string;
  encryptKey: string;
}): string {
  return gatewayBoundary.calculateFeishuCallbackSignature(
    input.rawBody,
    input.timestamp,
    input.nonce,
    input.encryptKey
  );
}

export function verifyFeishuCallbackRequestSignature(input: {
  rawBody: FeishuRawBody;
  headers: Headers;
  encryptKey: string;
}): boolean {
  return gatewayBoundary.verifyFeishuCallbackSignature(
    input.rawBody,
    input.headers,
    input.encryptKey
  );
}
