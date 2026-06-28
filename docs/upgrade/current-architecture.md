# Hermes V2 current architecture audit

Audit time: 2026-06-28

## Git baseline

- Working directory checked with `git status --short`: clean before audit writes.
- Current branch: `master`.
- HEAD commit: `677aff12b1347e36bde9cbdc398d656f2af29424`.
- Actual mounted project path in this Worker: `E:\projects\city-partner-platform`.
- Original task mentioned `C:\Projects\city-partner`; that path was not the active workspace for this run.

Recent 10 commits:

1. `677aff1 fix: repair dropped first character in worker paths`
2. `c94dfc5 worker: d40cbeba-8f51-452b-a6e0-c94e45c44c76 ...`
3. `65aace6 worker: 462610fc-528f-497f-904b-db448c17f6a6 ...`
4. `3afbe2d worker: cc5c4647-4c7f-4d6c-a7a7-1d8b0f98f3b8 ...`
5. `bc2b46f fix: return staged paths after directory staging validation`
6. `4691e20 fix: return staged paths after directory staging validation`
7. `81f9a98 fix: allow staging files inside untracked directories`
8. `0103eb5 worker: 38b46658-13bc-4f9c-98a7-08bd00de84a4 ...`
9. `d382dd7 worker: 24d94276-0fb6-47da-9274-776d139088b9 ...`
10. `85470c4 fix: kill stalled Codex process tree`

## Directory structure

Top-level directories:

- `app/`: legacy or duplicate app files.
- `src/app/`: active Next.js App Router pages and API route handlers.
- `src/lib/`: Supabase env helpers, Hermes agent, Worker helpers, Feishu sync helpers.
- `src/components/`: UI components.
- `src/types/`: database types.
- `infra/windows-worker/`: Windows local Worker source copy, tests, deployment scripts.
- `scripts/`: GitHub Action and Bitable helper scripts.
- `.github/workflows/`: CI, Hermes decomposition, Vercel deployment status workflow.
- `docs/`: setup SQL, operational docs, and this audit.

## Main data flow

1. Feishu event callback enters `src/app/api/feishu/event/route.ts`.
2. The handler verifies optional Feishu verification token, optionally decrypts encrypted payloads, filters for `im.message.receive_v1`, persists Feishu receipt records, loads Hermes conversation history, calls `runAgent()` from `src/lib/hermes-agent.ts`, stores new messages, and replies to Feishu.
3. Feishu Bitable automation can also enter `src/app/api/feishu/requirement/route.ts` or `src/app/api/feishu/codex-task/route.ts`; both insert rows into `hermes_queue`.
4. `.github/workflows/hermes-decompose.yml` runs `scripts/hermes_decompose_runner.py` every 5 minutes or manually. It reads `hermes_queue` pending rows, calls MiniMax, writes `task_results`, marks queue rows done or failed, optionally calls `DECOMPOSE_CALLBACK_URL`, and sends Feishu bot notifications.
5. Worker task execution uses `hermes_jobs`, not `hermes_queue`: `infra/windows-worker/local_worker.js` polls `GET /api/worker/next`, receives one job, runs Codex CLI, then reports progress and final state to `/api/worker/progress` and `/api/worker/report`.
6. Worker API routes update `hermes_jobs` through `src/lib/worker-jobs.ts` and call `syncWorkerStatusToFeishu()` from `src/lib/feishu-worker-sync.ts`.
7. Git commit and push are implemented in the outer Windows Worker (`infra/windows-worker/local_worker.js`), not in Codex.
8. Vercel deployment status is emitted by `.github/workflows/sync-vercel-deployment.yml` to a configured callback URL, but no matching repository API route was found.

## Real components

- Feishu message event endpoint: `src/app/api/feishu/event/route.ts`.
- Feishu Bitable requirement endpoint: `src/app/api/feishu/requirement/route.ts`.
- Feishu Bitable task-ready endpoint: `src/app/api/feishu/codex-task/route.ts`.
- Feishu Bitable decompose callback endpoint: `src/app/api/feishu/decompose-callback/route.ts`.
- Feishu Bitable table creator: `src/app/api/feishu/create-tables/route.ts`.
- Worker claim endpoint: `src/app/api/worker/next/route.ts`.
- Worker progress endpoint: `src/app/api/worker/progress/route.ts`.
- Worker report endpoint: `src/app/api/worker/report/route.ts`.
- Worker shared API helper: `src/lib/worker-jobs.ts`.
- Worker Feishu sync helper: `src/lib/feishu-worker-sync.ts`.
- Local Worker entry: `infra/windows-worker/local_worker.js`.
- Local Worker startup script: `infra/windows-worker/start-worker.ps1`.
- Worker deploy script: `infra/windows-worker/deploy-worker.ps1`.
- Git safety helper: `infra/windows-worker/git-safety.js`.
- Hermes queue SQL: `docs/setup-hermes-queue.sql`.
- Hermes jobs SQL: `docs/setup-hermes-jobs.sql`.
- Hermes conversation SQL: `docs/setup-hermes-conversations.sql`.

## Not found

- Server route for `/api/worker/heartbeat`: not found under `src/app/api`.
- Server callback route for Vercel deployment status with `X-Deploy-Secret`: not found under `src/app/api`.
- Atomic claim RPC or SQL function for `hermes_jobs`: not found.
- Retry/requeue route for expired `hermes_jobs`: not found.
- A migration that reconciles `hermes_jobs` SQL status values with Worker status values `queued` and `succeeded`: not found.

## Important implementation observations

- `src/app/api/worker/next/route.ts` selects one job with status in `["queued", "pending"]`, then updates it to `running`. The select and update are separate operations.
- `docs/setup-hermes-jobs.sql` defines allowed `hermes_jobs.status` values as `pending`, `running`, `awaiting_review`, `completed`, `failed`; current Worker code writes or reads `queued` and `succeeded`.
- `updateHermesJob()` silently skips missing columns for Supabase `PGRST204` missing-column errors. This improves compatibility but can hide schema drift.
- Several files display mojibake in comments and string literals when read in this environment. Some route files show apparent unterminated strings in the captured content. This audit does not modify those files.
