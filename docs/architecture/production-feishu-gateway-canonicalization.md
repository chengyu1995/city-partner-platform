# Production Feishu Gateway Canonicalization

The production Feishu entry is an HTTP callback, not a WebSocket long connection. Nginx forwards the exact `/feishu/event` route to the PM2 process `feishu-gateway` on `127.0.0.1:3002`.

## Source Of Truth

The only production Gateway source is `infra/tencent-worker/feishu_gateway_canonical.js`. It preserves the audited production behavior when canonical orchestration is disabled.

When canonical orchestration is enabled for an approval event, the Gateway returns before every legacy approval and Worker creation gate. It reconstructs context with `infra/tencent-worker/feishu-canonical-context-core.js`, signs the context envelope, and dispatches to the shared Next.js canonical application endpoint `/api/feishu/event` through `infra/tencent-worker/feishu_gateway_canonical_router.js`.

The Gateway does not create canonical jobs, attempts, leases, terminals, or Worker executions. Those operations remain owned by the canonical application and Worker state machine.

## Direct Artifact Mapping

No build is required. Deployment copies the three manifest files byte-for-byte to their declared target paths, checks SHA256 before and after transfer, runs `node --check` on all JavaScript files, atomically replaces the targets, and restarts only `feishu-gateway`.

The machine-readable mapping is `infra/tencent-worker/production-artifacts/feishu-gateway.json`. Run `npm run verify:feishu-gateway-artifact` from a clean checkout before packaging.

## Rollback

Back up every declared target before replacement. Rollback restores those exact files, re-runs `node --check`, and restarts only `feishu-gateway`. Canonical and shadow flags remain off during artifact activation.
