import gatewayRouter from "../../infra/tencent-worker/feishu_gateway_canonical_router.js";
import type { CanonicalApprovalContextResult } from "./feishu-canonical-context";

export const CANONICAL_GATEWAY_SIGNATURE_HEADER = gatewayRouter.SIGNATURE_HEADER as string;

export function readVerifiedCanonicalGatewayContext(input: {
  body: Record<string, unknown>;
  signature: string | null;
  secret: string;
}): CanonicalApprovalContextResult | null {
  const context = input.body._canonical_gateway_context;
  if (!context || typeof context !== "object") return null;
  const verified = gatewayRouter.verifyCanonicalGatewayContextSignature(context, input.signature, input.secret);
  return verified ? context as CanonicalApprovalContextResult : null;
}
