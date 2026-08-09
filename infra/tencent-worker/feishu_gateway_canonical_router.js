/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("crypto");
const { buildCanonicalApprovalContext } = require("./feishu-canonical-context-core.js");

const CANONICAL_FLAG = "HERMES_CANONICAL_ORCHESTRATION_ENABLED";
const SHADOW_FLAG = "HERMES_CANONICAL_SHADOW_ENABLED";
const ENDPOINT_ENV = "HERMES_CANONICAL_EVENT_URL";
const SIGNATURE_HEADER = "x-city-partner-canonical-context-signature";
const SOURCE_HEADER = "x-city-partner-feishu-gateway-source";

function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalContextPayload(context) {
  return JSON.stringify(stableValue(context));
}

function signCanonicalGatewayContext(context, secret) {
  if (!secret) throw new Error("CANONICAL_GATEWAY_SIGNING_SECRET_MISSING");
  return crypto.createHmac("sha256", secret).update(canonicalContextPayload(context)).digest("hex");
}

function verifyCanonicalGatewayContextSignature(context, signature, secret) {
  if (!context || !signature || !secret) return false;
  const expected = signCanonicalGatewayContext(context, secret);
  const left = Buffer.from(String(signature), "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function canonicalEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (!url.pathname.endsWith("/api/feishu/event")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function gatewayFailure(code, stage, detail, status = 503) {
  return {
    handled: true,
    status,
    ok: false,
    reply_text: [
      "PROJECT_DIRECTOR_HERMES_CANONICAL_CONTEXT_BLOCKED",
      "canonical_context_builder_used=true",
      "legacy_context_builder_used=false",
      "worker_created=false",
      "next_stage_allowed=false",
      `failure_code=${code}`,
      `failure_stage=${stage}`,
    ].join("\n"),
    response: {
      ok: false,
      routed: "canonical_gateway_fail_closed",
      canonical_context_builder_used: true,
      legacy_context_builder_used: false,
      worker_created: false,
      next_stage_allowed: false,
      failure_code: code,
      failure_stage: stage,
      failure_detail: String(detail || code).slice(0, 300),
    },
  };
}

function createCanonicalGatewayRouter(options = {}) {
  const runtimeEnv = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8_000;
  return {
    async route(input) {
      if (!enabled(runtimeEnv[CANONICAL_FLAG])) return { handled: false, reason: "canonical_flag_off" };
      if (enabled(runtimeEnv[SHADOW_FLAG])) {
        return gatewayFailure("CANONICAL_GATEWAY_FLAG_CONFLICT", "canonical_gateway_configuration", "shadow and canonical flags cannot both be enabled");
      }
      if (!input.is_approval) return { handled: false, reason: "non_approval_legacy_preserved" };
      const endpoint = canonicalEndpoint(runtimeEnv[ENDPOINT_ENV]);
      if (!endpoint) return gatewayFailure("CANONICAL_GATEWAY_ENDPOINT_INVALID", "canonical_gateway_configuration", `${ENDPOINT_ENV} must target /api/feishu/event`);
      const savedContextRecord = await input.load_saved_context(input.batch_code);
      const context = buildCanonicalApprovalContext({
        approval_text: input.approval_text,
        saved_context_record: savedContextRecord,
        request_id: input.request_id,
        approved_by: input.approved_by,
        approved_at: input.approved_at,
        feishu_chat_id: input.feishu_chat_id,
        feishu_event_id: input.feishu_event_id,
      });
      if (!context.ok) return gatewayFailure(context.failure_code, context.failure_stage, "canonical approval context is incomplete", 409);
      const secret = String(runtimeEnv.FEISHU_APP_SECRET || "").trim();
      if (!secret) return gatewayFailure("CANONICAL_GATEWAY_SIGNING_SECRET_MISSING", "canonical_gateway_configuration", "FEISHU_APP_SECRET is required");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const signature = signCanonicalGatewayContext(context, secret);
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature, [SOURCE_HEADER]: "tencent-pm2-feishu-gateway" },
          body: JSON.stringify({ ...input.body, _canonical_gateway_context: context, _canonical_gateway_context_version: "1.0" }),
          signal: controller.signal,
        });
        const responseText = await response.text();
        let responseBody;
        try { responseBody = JSON.parse(responseText); }
        catch { responseBody = { code: response.status, msg: "canonical gateway returned non-json" }; }
        if (!response.ok) return gatewayFailure("CANONICAL_GATEWAY_DOWNSTREAM_REJECTED", "canonical_gateway_dispatch", `HTTP ${response.status}`, 502);
        return { handled: true, status: response.status, ok: true, reply_text: null, response: responseBody, canonical_context: context };
      } catch (error) {
        const code = error?.name === "AbortError" ? "CANONICAL_GATEWAY_TIMEOUT" : "CANONICAL_GATEWAY_DISPATCH_FAILED";
        return gatewayFailure(code, "canonical_gateway_dispatch", error?.message || String(error), 502);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  CANONICAL_FLAG,
  SHADOW_FLAG,
  ENDPOINT_ENV,
  SIGNATURE_HEADER,
  SOURCE_HEADER,
  createCanonicalGatewayRouter,
  signCanonicalGatewayContext,
  verifyCanonicalGatewayContextSignature,
};
