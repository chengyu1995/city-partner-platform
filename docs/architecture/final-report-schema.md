# Final Report Schema

This document records the BATCH-ARCH-09 final-state contract for the automation system. It describes the normalized result shared by the Windows Worker final report, failure memory, terminal indexing, and automatic iteration suggestions.

## Normalized Final Result

Every terminal Worker result is first normalized into one structured object. Failure memory and the final report must read this object; they must not re-parse natural-language report text independently.

Required normalized fields:

- `job_id`
- `approved_batch`
- `final_report_status`
- `effective_final_status`
- `failure_code`
- `failure_stage`
- `git_commit_sha`
- `next_batch`
- `completed_at`
- `failure_memory_status`
- `terminal_index`
- `auto_iteration_suggestion`

## Failure Memory Rules

Failure memory is written only for true task failures:

- `TEST_FAILED`
- `TYPESCRIPT_FAILED`
- `OUT_OF_SCOPE_CHANGE`
- `CONTEXT_RECONSTRUCT_FAILED`
- `GIT_COMMIT_FAILED`
- `GIT_PUSH_FAILED`

Failure memory is not written, and the original task terminal state is not changed, for non-task reporting failures:

- `FEISHU_RATE_LIMIT`
- `FEISHU_SEND_FAILED`
- `BITABLE_RECORD_MISSING`
- `BITABLE_SYNC_FAILED`
- `DUPLICATE_REPORT`
- `PROGRESS_REPORT_FAILED`

Cancelled tasks are terminal, but they do not create failure memory and do not generate automatic repair batches.

## Terminal Index

Each terminal task records one idempotent terminal index entry keyed by `job_id::approved_batch`.

Index fields:

- `job_id`
- `approved_batch`
- `effective_final_status`
- `failure_code`
- `git_commit_sha`
- `next_batch`
- `completed_at`

Duplicate final reports for the same key return the stored entry and must not write another index entry, another failure-memory entry, another final report notification, or a changed terminal status.

## Next Batch

Succeeded results preserve `next_batch` in the normalized final result and terminal index. The next iteration reads this value directly. For BATCH-ARCH-09, the expected next batch is `BATCH-ARCH-10`.

## Automatic Iteration Suggestion

- `succeeded`: continue with `next_batch` when present.
- `failed`: generate the smallest repair batch from `failure_code` and `failure_stage`.
- `cancelled`: generate no repair batch.
