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
