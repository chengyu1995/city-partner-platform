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

## Later Batches

- Add richer result aggregation.
- Add thread-level dependency completion checks.
- Add dashboard visibility for task trees.
- Add human approval UI for high-risk tasks.

