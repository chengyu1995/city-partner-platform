# Project Director Upgrade Roadmap

## Completed Before BATCH-15

- Architecture audit.
- System upgrade freeze.
- Task ownership and idempotent reporting.
- Initial task tree and role concept.

## BATCH-15

- Add stable Agent role definitions.
- Generate task trees with allowed and forbidden file scopes.
- Generate dispatch plans with dependency order and approval gates.
- Queue planning and approved execution tasks without database schema changes.
- Keep Worker request claiming backward compatible.
- Freeze business page development while system-upgrade dispatcher work is active.
- Default Worker preview smoke to off so BATCH-15 uses static diagnostics instead of local dev preview.

## Later Batches

- Add richer result aggregation.
- Add thread-level dependency completion checks.
- Add dashboard visibility for task trees.
- Add human approval UI for high-risk tasks.

## BATCH-19 Final Status

BATCH-14 through BATCH-19 are completed. The project director system is no longer in the
system-upgrade freeze mode. It is now in formal project director mode:

- Website product requests can enter planning.
- Website product requests still do not go directly to Codex.
- Boss approval is still required before Worker/Codex dispatch.
- High-risk actions still require explicit boss confirmation.
- Stashed or isolated business-page changes stay frozen unless the boss explicitly approves recovery.

## BATCH-20 Production Hardening

BATCH-20 completes the last operational hardening step before formal website planning:

- Boss console short commands are recognized before ordinary website demand routing.
- `新需求：系统自检` and `总管 系统自检` return a read-only operational health summary.
- `新需求：Agent 状态/看板` and `总管 Agent 状态/看板` return the static 8-Agent dashboard.
- Git `main/master` alignment is documented; recommended production branch is `main`.
- MVP stage 1 starts only with a planning-only template and waits for `总管 批准执行`.
- BATCH-20 still does not begin business page development.
