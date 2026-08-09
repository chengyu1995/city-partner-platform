/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("crypto");

const APPLICATION_ENDPOINT_ENV = "FEISHU_APPLICATION_EVENT_URL";
const LEGACY_ENDPOINT_ENV = "HERMES_CANONICAL_EVENT_URL";
const SIGNATURE_HEADER = "x-city-partner-feishu-application-signature";
const SOURCE_HEADER = "x-city-partner-feishu-gateway-source";
const TRANSPORT_REQUEST_ID_HEADER = "x-city-partner-transport-request-id";
const SOURCE_ID = "tencent-pm2-feishu-gateway";
const FEISHU_TIMESTAMP_HEADER = "x-lark-request-timestamp";
const FEISHU_NONCE_HEADER = "x-lark-request-nonce";
const FEISHU_SIGNATURE_HEADER = "x-lark-signature";
const CONTENT_TYPE_HEADER = "content-type";
const REQUIRED_FEISHU_FORWARD_HEADERS = Object.freeze([
  FEISHU_TIMESTAMP_HEADER,
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  CONTENT_TYPE_HEADER,
]);
const FEISHU_CALLBACK_EXTERNAL_DEADLINE_MS = 3_000;
const APPLICATION_ACCEPT_TIMEOUT_MS = 1_500;
const GATEWAY_INTERNAL_RESPONSE_BUDGET_MS = 2_000;

function resolveApplicationEndpoint(env = process.env) {
  const value = env[APPLICATION_ENDPOINT_ENV] || env[LEGACY_ENDPOINT_ENV];
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

function bodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody);
  if (ArrayBuffer.isView(rawBody)) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  return Buffer.from(String(rawBody || ""), "utf8");
}

function readHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return Array.isArray(value) ? String(value[0] || "") : String(value || "");
    }
  }
  return "";
}

function selectFeishuForwardHeaders(headers) {
  const selected = {};
  for (const name of REQUIRED_FEISHU_FORWARD_HEADERS) {
    const value = readHeader(headers, name);
    if (value) selected[name] = value;
  }
  return selected;
}

function signApplicationPayload(rawBody, secret) {
  if (!secret) throw Object.assign(new Error("FEISHU_APPLICATION_SIGNING_SECRET_MISSING"), { code: "FEISHU_APPLICATION_SIGNING_SECRET_MISSING" });
  return crypto.createHmac("sha256", secret).update(bodyBytes(rawBody)).digest("hex");
}

function verifyApplicationPayloadSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = signApplicationPayload(rawBody, secret);
  const left = Buffer.from(String(signature), "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function calculateFeishuCallbackSignature(rawBody, timestamp, nonce, encryptKey) {
  const hash = crypto.createHash("sha256");
  hash.update(String(timestamp || ""), "utf8");
  hash.update(String(nonce || ""), "utf8");
  hash.update(String(encryptKey || ""), "utf8");
  hash.update(bodyBytes(rawBody));
  return hash.digest("hex");
}

function verifyFeishuCallbackSignature(rawBody, headers, encryptKey) {
  const timestamp = readHeader(headers, FEISHU_TIMESTAMP_HEADER);
  const nonce = readHeader(headers, FEISHU_NONCE_HEADER);
  const signature = readHeader(headers, FEISHU_SIGNATURE_HEADER).toLowerCase();
  if (!timestamp || !nonce || !signature || !encryptKey) return false;
  const expected = calculateFeishuCallbackSignature(rawBody, timestamp, nonce, encryptKey);
  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createFeishuApplicationBoundaryClient(options = {}) {
  const runtimeEnv = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : APPLICATION_ACCEPT_TIMEOUT_MS;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;

  if (timeoutMs > APPLICATION_ACCEPT_TIMEOUT_MS) {
    throw Object.assign(new Error("FEISHU_APPLICATION_ACCEPT_TIMEOUT_UNSAFE"), { code: "FEISHU_APPLICATION_ACCEPT_TIMEOUT_UNSAFE" });
  }

  return {
    async dispatch(input) {
      const endpoint = resolveApplicationEndpoint(runtimeEnv);
      if (!endpoint) {
        throw Object.assign(new Error("FEISHU_APPLICATION_ENDPOINT_INVALID"), { code: "FEISHU_APPLICATION_ENDPOINT_INVALID" });
      }
      const secret = String(runtimeEnv.FEISHU_APP_SECRET || "").trim();
      const signature = signApplicationPayload(input.rawBody, secret);
      const forwardedHeaders = selectFeishuForwardHeaders(input.headers);
      const controller = new AbortController();
      const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...forwardedHeaders,
            [CONTENT_TYPE_HEADER]: forwardedHeaders[CONTENT_TYPE_HEADER] || "application/json",
            [SIGNATURE_HEADER]: signature,
            [SOURCE_HEADER]: SOURCE_ID,
            [TRANSPORT_REQUEST_ID_HEADER]: String(input.transportRequestId || ""),
          },
          body: bodyBytes(input.rawBody),
          signal: controller.signal,
        });
        const responseText = await response.text();
        let responseBody;
        try { responseBody = JSON.parse(responseText); }
        catch { responseBody = { code: response.status, msg: "feishu application boundary returned non-json" }; }
        if (!response.ok) {
          throw Object.assign(new Error("FEISHU_APPLICATION_ACCEPTANCE_REJECTED"), {
            code: "FEISHU_APPLICATION_ACCEPTANCE_REJECTED",
            status: response.status,
            responseBody,
          });
        }
        return { status: response.status, body: responseBody };
      } catch (error) {
        if (error?.name === "AbortError") {
          throw Object.assign(new Error("FEISHU_APPLICATION_BOUNDARY_TIMEOUT"), {
            code: "FEISHU_APPLICATION_BOUNDARY_TIMEOUT",
            status: 504,
            forwardTimeout: true,
          });
        }
        throw error;
      } finally {
        clearTimeoutImpl(timer);
      }
    },
  };
}

module.exports = {
  APPLICATION_ENDPOINT_ENV,
  LEGACY_ENDPOINT_ENV,
  SIGNATURE_HEADER,
  SOURCE_HEADER,
  TRANSPORT_REQUEST_ID_HEADER,
  SOURCE_ID,
  FEISHU_TIMESTAMP_HEADER,
  FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER,
  CONTENT_TYPE_HEADER,
  REQUIRED_FEISHU_FORWARD_HEADERS,
  FEISHU_CALLBACK_EXTERNAL_DEADLINE_MS,
  APPLICATION_ACCEPT_TIMEOUT_MS,
  GATEWAY_INTERNAL_RESPONSE_BUDGET_MS,
  calculateFeishuCallbackSignature,
  createFeishuApplicationBoundaryClient,
  readHeader,
  resolveApplicationEndpoint,
  selectFeishuForwardHeaders,
  signApplicationPayload,
  verifyApplicationPayloadSignature,
  verifyFeishuCallbackSignature,
};
