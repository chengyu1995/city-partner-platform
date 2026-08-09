/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const express = require("express");
const dotenv = require("dotenv");
const {
  createFeishuApplicationBoundaryClient,
  resolveApplicationEndpoint,
} = require("./feishu_gateway_canonical_router.js");

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ path: ".env", override: false });

const DEFAULT_PORT = 3002;
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEDUPE_CAPACITY = 5000;

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function eventDedupeKey(body) {
  if (!body || typeof body !== "object") return "";
  const event = body.event && typeof body.event === "object" ? body.event : body;
  const header = body.header || event.header || {};
  const message = event.message || {};
  const eventId = stringValue(header.event_id);
  if (eventId) return `event:${eventId}`;
  const messageId = stringValue(message.message_id);
  return messageId ? `message:${messageId}` : "";
}

function createTransportDedupe(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_DEDUPE_TTL_MS;
  const capacity = Number.isSafeInteger(options.capacity) ? options.capacity : DEFAULT_DEDUPE_CAPACITY;
  const now = options.now || Date.now;
  const entries = new Map();

  function prune() {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
    while (entries.size > capacity) entries.delete(entries.keys().next().value);
  }

  return {
    async run(key, operation) {
      if (!key) return { duplicate: false, result: await operation() };
      prune();
      const existing = entries.get(key);
      if (existing) return { duplicate: true, result: await existing.promise };

      const entry = {
        expiresAt: now() + ttlMs,
        promise: Promise.resolve().then(operation),
      };
      entries.set(key, entry);
      try {
        const result = await entry.promise;
        entry.expiresAt = now() + ttlMs;
        return { duplicate: false, result };
      } catch (error) {
        entries.delete(key);
        throw error;
      }
    },
    size() {
      prune();
      return entries.size;
    },
  };
}

function createGatewayApp(options = {}) {
  const runtimeEnv = options.env || process.env;
  const logger = options.logger || console;
  const client = options.client || createFeishuApplicationBoundaryClient({ env: runtimeEnv });
  const dedupe = options.dedupe || createTransportDedupe();
  const app = express();

  app.use(express.json({
    limit: "2mb",
    verify(req, _res, buffer) {
      req.rawBody = buffer.toString("utf8");
    },
  }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      role: "feishu_transport_adapter",
      application_boundary_configured: Boolean(resolveApplicationEndpoint(runtimeEnv)),
      transport_dedupe_entries: dedupe.size(),
    });
  });

  app.post("/feishu/event", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.type === "url_verification" && typeof body.challenge === "string") {
      return res.json({ challenge: body.challenge });
    }

    const rawBody = stringValue(req.rawBody) || JSON.stringify(body);
    const dedupeKey = eventDedupeKey(body);
    try {
      const dispatch = await dedupe.run(dedupeKey, () => client.dispatch({ body, rawBody }));
      if (dispatch.duplicate) res.setHeader("x-city-partner-transport-deduplicated", "true");
      return res.status(dispatch.result.status).json(dispatch.result.body);
    } catch (error) {
      logger.error("[feishu-gateway] application boundary dispatch failed", error?.code || error?.message || String(error));
      return res.status(502).json({
        code: 502,
        msg: "feishu application boundary unavailable",
        failure_code: error?.code || "FEISHU_APPLICATION_BOUNDARY_UNAVAILABLE",
      });
    }
  });

  app.use((error, _req, res, _next) => {
    void _next;
    logger.error("[feishu-gateway] invalid callback payload", error?.message || String(error));
    res.status(400).json({ code: 400, msg: "invalid callback payload" });
  });

  return app;
}

function startGateway(options = {}) {
  const runtimeEnv = options.env || process.env;
  const port = Number(runtimeEnv.FEISHU_GATEWAY_PORT || runtimeEnv.PORT || DEFAULT_PORT);
  const host = runtimeEnv.FEISHU_GATEWAY_HOST || "127.0.0.1";
  return createGatewayApp({ ...options, env: runtimeEnv }).listen(port, host, () => {
    (options.logger || console).log(`[feishu-gateway] transport adapter listening on http://${host}:${port}`);
  });
}

if (require.main === module) startGateway();

module.exports = {
  createGatewayApp,
  createTransportDedupe,
  eventDedupeKey,
  startGateway,
};
