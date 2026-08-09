import gatewayBoundary from "../../infra/tencent-worker/feishu_gateway_canonical_router.js";

export const FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER = gatewayBoundary.SIGNATURE_HEADER as string;
export const FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER = gatewayBoundary.SOURCE_HEADER as string;
export const FEISHU_APPLICATION_BOUNDARY_SOURCE_ID = gatewayBoundary.SOURCE_ID as string;

export function verifyFeishuApplicationBoundaryRequest(input: {
  rawBody: string;
  signature: string | null;
  source: string | null;
  secret: string;
}): boolean {
  if (input.source !== FEISHU_APPLICATION_BOUNDARY_SOURCE_ID) return false;
  return gatewayBoundary.verifyApplicationPayloadSignature(input.rawBody, input.signature, input.secret);
}
