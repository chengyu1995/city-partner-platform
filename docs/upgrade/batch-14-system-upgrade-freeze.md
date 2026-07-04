# BATCH-14 System Upgrade Freeze

Effective date: 2026-07-05
Status: active until the project director system upgrade is complete.

## Freeze Rule

During BATCH-14 through BATCH-19, all Worker tasks must prioritize system upgrade work. Business feature development is frozen.

## Allowed Work

- Worker API ownership, heartbeat, progress, and report reliability.
- Idempotency and duplicate-report prevention.
- Project director task routing and architecture documents.
- Upgrade-roadmap documents.
- Static validation and syntax/type checks.
- Documentation required to operate or verify the system upgrade.

## Forbidden Work

- No website page development.
- No `/post` fixes.
- No `/partners` fixes.
- No UI optimization.
- No product-copy changes.
- No business data model expansion unrelated to the system upgrade.
- No production deployment or production environment variable edits.
- No database migration execution by Codex.
- No local dev server or browser preview during Windows Worker execution.

## Enforcement

- If a task mixes system upgrade work with business page work, the Worker must treat the business work as out of scope.
- If Codex sees dirty business files, it must not overwrite or normalize them for this system upgrade.
- Validation failures from unavailable local preview are warnings only; static validation remains the accepted check path.
- Git commit and push are owned by the outer Worker only.

## Exit Criteria

The freeze can be lifted only after BATCH-19 confirms:

- Worker claim and report contracts are stable.
- Heartbeat and stale-job behavior are observable.
- Feishu writeback has a retryable path or a documented manual fallback.
- Upgrade documents and operator runbooks match runtime behavior.
- A human owner accepts the project director system as upgraded.

