# BATCH-18 Test Cases

## Scope

These cases verify the Project Director full chain using fake tasks only. They intentionally avoid business-page development.

## Case Matrix

| ID | Input | Expected state | Queue expectation | Pass criteria |
| --- | --- | --- | --- | --- |
| B18-01 | `总管 帮助` | Console reply | No Worker job | `parseProjectDirectorConsoleCommand` maps to `help`. |
| B18-02 | `总管 状态` | Status reply | No Worker job | Reply includes pause, recent demand, recent plan, running, completed, and failure sections. |
| B18-03 | `总管 暂停` | Pause recorded | No Worker job | Latest console record has `agent_dispatch_paused: true`. |
| B18-04 | `总管 恢复` | Resume recorded | No Worker job | Latest console record has `agent_dispatch_paused: false`. |
| B18-05 | `新需求：做一个假的测试需求，不要改任何业务页面，只验证总管拆解流程` | Planning/task tree | No executable Worker job | Planning record says job is not inserted before boss approval. |
| B18-06 | Approval while paused | Blocked | No Worker job | Feishu route returns paused blocked state before insert. |
| B18-07 | `总管 批准执行` after plan and resume | Approved dispatch | Worker jobs inserted | Jobs include dispatch metadata and attempt contract. |
| B18-08 | Worker calls `/api/worker/next` | Running claim | One job claimed | Response contains `attempt_id`, Worker owner, and Project Director correlation. |
| B18-09 | Worker progress without `attempt_id` | Rejected | No overwrite | Active job attempt rejects missing `attempt_id`. |
| B18-10 | Worker report with wrong `attempt_id` | Rejected | No overwrite | API returns attempt mismatch. |
| B18-11 | Worker report with matching `attempt_id` | Accepted | Status updated | Report stores Project Director report data. |
| B18-12 | Later failed report after succeeded | Idempotent skipped | No overwrite | Existing terminal status is preserved. |
| B18-13 | Later succeeded report after failed | Idempotent skipped | No overwrite | Existing terminal status is preserved. |
| B18-14 | `验收反馈：这是 BATCH-18 假反馈，不要修改业务页面` | Feedback recorded or diagnosis queued | No direct business-page edit | Frozen pages remain unchanged. |
| B18-15 | Empty queue or already claimed job | No work | No duplicate execution | Worker next returns null or `already_claimed_or_not_runnable`. |

## Static Checks

Run:

```bash
node scripts/batch-18-full-chain-static-check.js
```

Expected:

- All checks print `PASS`.
- The output prints the BATCH-18 static message matrix.
- The script exits with code 0.

## TypeScript And ESLint

Run:

```bash
npx tsc --noEmit
npx eslint src/lib/worker-jobs.ts
```

Expected:

- TypeScript exits 0.
- ESLint exits 0 for the modified TS file.

## Frozen Page Check

Run:

```bash
git diff --name-only
git status --short
```

Expected:

- No listed file is one of the frozen business pages.
- No `.env`, database schema, production deploy, or dependency file is changed.

## Warnings To Record

- This is a static local self-test, not a live Feishu/Supabase integration test.
- If local TypeScript or ESLint fails because of pre-existing repository issues, record the failure as a warning with the command output.
- Do not start `npm run dev`, `next dev`, a browser, or production deploy for BATCH-18.
