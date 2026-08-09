# Production Feishu Gateway Canonicalization

The production Feishu entry is an Nginx HTTP callback. Nginx forwards `/feishu/event` to the PM2 process `feishu-gateway` on `127.0.0.1:3002`; no WebSocket long connection is involved.

## Authority Boundary

`infra/tencent-worker/feishu_gateway_canonical.js` is the only production PM2 source. It is a thin transport adapter: URL verification, bounded in-memory event dedupe, HTTP acknowledgement, logging, and signed dispatch to `/api/feishu/event`.

The PM2 entrypoint has no GM routing, feature routing, job creation, Supabase persistence, Worker execution, or terminal authority. `src/app/api/feishu/event/route.ts` is the single Feishu application boundary. `src/lib/feishu-application-boundary.ts` owns the Legacy, Shadow, and Canonical feature routing contract.

The canonical context rules remain implemented once in `infra/tencent-worker/feishu-canonical-context-core.js`; `src/lib/feishu-canonical-context.ts` is its typed adapter.

## Direct Artifact Mapping

No build is required. Deployment copies the two manifest files byte-for-byte, verifies SHA256, runs `node --check`, atomically replaces the targets, and restarts only `feishu-gateway`. `FEISHU_APPLICATION_EVENT_URL` must resolve to the shared `/api/feishu/event` boundary; `HERMES_CANONICAL_EVENT_URL` remains an endpoint-name compatibility fallback and does not control feature routing.

Run `npm run verify:feishu-gateway-artifact` from a clean checkout before packaging. The verifier fails on direct database persistence, job creation, GM routing, Worker execution, or terminal-state markers in the real PM2 entrypoint.

## Rollback

Back up every manifest target before replacement. Rollback restores those files, re-runs `node --check`, and restarts only `feishu-gateway`. No schema or historical execution data is removed.
