# Production Feishu Gateway Canonicalization

The production Feishu entry is an Nginx HTTP callback. Nginx forwards `/feishu/event` to the PM2 process `feishu-gateway` on `127.0.0.1:3002`; no WebSocket long connection is involved.

## Authority Boundary

`infra/tencent-worker/feishu_gateway_canonical.js` is the only production PM2 source. It is a thin transport adapter: URL verification, bounded in-memory event dedupe, HTTP acknowledgement, logging, and signed dispatch to `/api/feishu/event`.

The PM2 entrypoint has no GM routing, feature routing, job creation, Supabase persistence, Worker execution, or terminal authority. `src/app/api/feishu/event/route.ts` is the single Feishu application boundary. `src/lib/feishu-application-boundary.ts` owns the Legacy, Shadow, and Canonical feature routing contract.

The canonical context rules remain implemented once in `infra/tencent-worker/feishu-canonical-context-core.js`; `src/lib/feishu-canonical-context.ts` is its typed adapter.

## Callback Acceptance Contract

Feishu's external callback deadline is 3000ms. The Gateway reserves transport margin by limiting the Application acceptance request to 1500ms and its own response budget to 2000ms. A timeout, network failure, authentication rejection, or Application 5xx is returned as a non-2xx response so Feishu can retry; it is never converted into a successful acknowledgement.

The Gateway reads the callback body once as bytes and forwards those exact bytes with the original `X-Lark-Request-Timestamp`, `X-Lark-Request-Nonce`, `X-Lark-Signature`, and `Content-Type` values. It does not forward cookies, authorization headers, or runtime credentials. The Application verifies both the Gateway envelope and the Feishu signature against the raw body before parsing or performing any business action.

`src/app/api/feishu/event/route.ts` returns only a transport acceptance after authentication and envelope validation. Long-running work is registered with the Next.js `after()` lifecycle primitive and continues through the existing shared Application Boundary. A transport 2xx does not represent Hermes, Worker, terminal, or task success.

## Direct Artifact Mapping

No build is required. Deployment copies the two manifest files byte-for-byte, verifies SHA256, runs `node --check`, atomically replaces the targets, and restarts only `feishu-gateway`. `FEISHU_APPLICATION_EVENT_URL` must resolve to the shared `/api/feishu/event` boundary; `HERMES_CANONICAL_EVENT_URL` remains an endpoint-name compatibility fallback and does not control feature routing.

Run `npm run verify:feishu-gateway-artifact` from a clean checkout before packaging. The verifier fails on direct database persistence, job creation, GM routing, Worker execution, or terminal-state markers in the real PM2 entrypoint.

## Rollback

Back up every manifest target before replacement. Rollback restores those files, re-runs `node --check`, and restarts only `feishu-gateway`. No schema or historical execution data is removed.
