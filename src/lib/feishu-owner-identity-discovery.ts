import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcceptedFeishuCallback } from "@/lib/feishu-callback-application";

export const CANARY_OWNER_IDENTITY_RECEIPT_PURPOSE =
  "CANARY_OWNER_IDENTITY_DISCOVERY_V1";
export const IDENTITY_DISCOVERY_COMMAND_REGEX =
  /^总管 身份验证 ([0-9a-f]{64})$/;

const IDENTITY_DISCOVERY_NAMESPACE_REGEX = /^\s*总管 身份验证(?:\s|$)/;
type IdentityDiscoveryCandidate = {
  reserved: true;
  commandValid: true;
  nonceSha256: string;
  verifiedOwnerOpenId: string;
  verifiedEventId: string;
};

export type IdentityDiscoveryInspection =
  | { reserved: false; commandValid: false; reasonCode: "NOT_RESERVED" }
  | { reserved: true; commandValid: false; reasonCode: string }
  | IdentityDiscoveryCandidate;

export type IdentityDiscoveryCaptureResult = {
  captureOutcome:
    | "CAPTURED"
    | "IDEMPOTENT_ALREADY_CAPTURED"
    | "DENIED"
    | "IDENTITY_CAPTURE_OUTCOME_UNKNOWN";
  receiptId: string | null;
  nonceSha256: string | null;
  ownerOpenIdSha256: string | null;
  verifiedEventIdSha256: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function callbackMessageText(payload: Record<string, unknown>): string {
  const event = record(payload.event);
  const message = record(event.message);
  const content = stringValue(message.content);
  if (!content) return "";

  try {
    return stringValue(record(JSON.parse(content)).text);
  } catch {
    return "";
  }
}

export function inspectAcceptedIdentityDiscovery(
  accepted: AcceptedFeishuCallback
): IdentityDiscoveryInspection {
  const payload = record(accepted.payload);
  const event = record(payload.event);
  const message = record(event.message);
  const text = callbackMessageText(payload);

  if (!IDENTITY_DISCOVERY_NAMESPACE_REGEX.test(text)) {
    return { reserved: false, commandValid: false, reasonCode: "NOT_RESERVED" };
  }

  const command = IDENTITY_DISCOVERY_COMMAND_REGEX.exec(text);
  if (!command) {
    return {
      reserved: true,
      commandValid: false,
      reasonCode: "IDENTITY_DISCOVERY_COMMAND_INVALID",
    };
  }

  const sender = record(event.sender);
  const senderId = record(sender.sender_id);
  const ownerOpenId = stringValue(senderId.open_id).trim();
  const eventId = accepted.event_id.trim();

  if (accepted.event_type !== "im.message.receive_v1") {
    return {
      reserved: true,
      commandValid: false,
      reasonCode: "IDENTITY_DISCOVERY_EVENT_TYPE_DENIED",
    };
  }
  if (stringValue(message.chat_type) !== "p2p") {
    return {
      reserved: true,
      commandValid: false,
      reasonCode: "IDENTITY_DISCOVERY_CHAT_TYPE_DENIED",
    };
  }
  if (stringValue(sender.sender_type) !== "user") {
    return {
      reserved: true,
      commandValid: false,
      reasonCode: "IDENTITY_DISCOVERY_SENDER_TYPE_DENIED",
    };
  }
  if (!ownerOpenId || !eventId) {
    return {
      reserved: true,
      commandValid: false,
      reasonCode: "IDENTITY_DISCOVERY_TRUSTED_IDENTITY_INCOMPLETE",
    };
  }

  return {
    reserved: true,
    commandValid: true,
    nonceSha256: sha256(command[1]),
    verifiedOwnerOpenId: ownerOpenId,
    verifiedEventId: eventId,
  };
}

function captureRow(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return record(data[0]);
  return record(data);
}

export async function captureAcceptedIdentityDiscovery(
  inspection: IdentityDiscoveryInspection,
  supabase: SupabaseClient | null
): Promise<IdentityDiscoveryCaptureResult> {
  if (!inspection.reserved || !inspection.commandValid) {
    return {
      captureOutcome: "DENIED",
      receiptId: null,
      nonceSha256: null,
      ownerOpenIdSha256: null,
      verifiedEventIdSha256: null,
    };
  }

  const ownerOpenIdSha256 = sha256(inspection.verifiedOwnerOpenId);
  const verifiedEventIdSha256 = sha256(inspection.verifiedEventId);
  if (!supabase) {
    return {
      captureOutcome: "IDENTITY_CAPTURE_OUTCOME_UNKNOWN",
      receiptId: null,
      nonceSha256: inspection.nonceSha256,
      ownerOpenIdSha256,
      verifiedEventIdSha256,
    };
  }

  try {
    const { data, error } = await supabase.rpc(
      "capture_canary_owner_identity_receipt",
      {
        p_nonce_sha256: inspection.nonceSha256,
        p_verified_owner_open_id: inspection.verifiedOwnerOpenId,
        p_verified_event_id: inspection.verifiedEventId,
      }
    );
    if (error) {
      return {
        captureOutcome: "IDENTITY_CAPTURE_OUTCOME_UNKNOWN",
        receiptId: null,
        nonceSha256: inspection.nonceSha256,
        ownerOpenIdSha256,
        verifiedEventIdSha256,
      };
    }

    const row = captureRow(data);
    const outcome = stringValue(row.capture_outcome);
    if (
      outcome !== "CAPTURED" &&
      outcome !== "IDEMPOTENT_ALREADY_CAPTURED" &&
      outcome !== "DENIED"
    ) {
      return {
        captureOutcome: "IDENTITY_CAPTURE_OUTCOME_UNKNOWN",
        receiptId: null,
        nonceSha256: inspection.nonceSha256,
        ownerOpenIdSha256,
        verifiedEventIdSha256,
      };
    }

    return {
      captureOutcome: outcome,
      receiptId: stringValue(row.receipt_id) || null,
      nonceSha256: inspection.nonceSha256,
      ownerOpenIdSha256,
      verifiedEventIdSha256,
    };
  } catch {
    return {
      captureOutcome: "IDENTITY_CAPTURE_OUTCOME_UNKNOWN",
      receiptId: null,
      nonceSha256: inspection.nonceSha256,
      ownerOpenIdSha256,
      verifiedEventIdSha256,
    };
  }
}

export function buildIdentityDiscoveryAuditRecord(
  inspection: IdentityDiscoveryInspection,
  result: IdentityDiscoveryCaptureResult
): Record<string, string | boolean | null> {
  return {
    reserved_identity_namespace: inspection.reserved,
    command_valid: inspection.commandValid,
    reason_code:
      inspection.reserved && !inspection.commandValid
        ? inspection.reasonCode
        : result.captureOutcome,
    receipt_id: result.receiptId,
    nonce_sha256: result.nonceSha256,
    owner_open_id_sha256: result.ownerOpenIdSha256,
    verified_event_id_sha256: result.verifiedEventIdSha256,
  };
}
