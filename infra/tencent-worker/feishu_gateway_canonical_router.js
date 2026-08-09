/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("crypto");

const APPLICATION_ENDPOINT_ENV = "FEISHU_APPLICATION_EVENT_URL";
const LEGACY_ENDPOINT_ENV = "HERMES_CANONICAL_EVENT_URL";
const SIGNATURE_HEADER = "x-city-partner-feishu-application-signature";
const SOURCE_HEADER = "x-city-partner-feishu-gateway-source";
const SOURCE_ID = "tencent-pm2-feishu-gateway";

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

function signApplicationPayload(rawBody, secret) {
  if (!secret) throw Object.assign(new Error("FEISHU_APPLICATION_SIGNING_SECRET_MISSING"), { code: "FEISHU_APPLICATION_SIGNING_SECRET_MISSING" });
  return crypto.createHmac("sha256", secret).update(String(rawBody || "")).digest("hex");
}

function verifyApplicationPayloadSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = signApplicationPayload(rawBody, secret);
  const left = Buffer.from(String(signature), "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createFeishuApplicationBoundaryClient(options = {}) {
  const runtimeEnv = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8_000;

  return {
    async dispatch(input) {
      const endpoint = resolveApplicationEndpoint(runtimeEnv);
      if (!endpoint) {
        throw Object.assign(new Error("FEISHU_APPLICATION_ENDPOINT_INVALID"), { code: "FEISHU_APPLICATION_ENDPOINT_INVALID" });
      }
      const secret = String(runtimeEnv.FEISHU_APP_SECRET || "").trim();
      const signature = signApplicationPayload(input.rawBody, secret);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signature,
            [SOURCE_HEADER]: SOURCE_ID,
          },
          body: input.rawBody,
          signal: controller.signal,
        });
        const responseText = await response.text();
        let responseBody;
        try { responseBody = JSON.parse(responseText); }
        catch { responseBody = { code: response.status, msg: "feishu application boundary returned non-json" }; }
        return { status: response.status, body: responseBody };
      } catch (error) {
        if (error?.name === "AbortError") {
          throw Object.assign(new Error("FEISHU_APPLICATION_BOUNDARY_TIMEOUT"), { code: "FEISHU_APPLICATION_BOUNDARY_TIMEOUT" });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  APPLICATION_ENDPOINT_ENV,
  LEGACY_ENDPOINT_ENV,
  SIGNATURE_HEADER,
  SOURCE_HEADER,
  SOURCE_ID,
  createFeishuApplicationBoundaryClient,
  resolveApplicationEndpoint,
  signApplicationPayload,
  verifyApplicationPayloadSignature,
};
