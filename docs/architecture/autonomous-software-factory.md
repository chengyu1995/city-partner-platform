# Autonomous Software Factory

## Product goal

The owner submits a product request in Feishu. The system turns it into a product plan,
design tasks, implementation tasks, tests, a Preview deployment, and a final evidence
packet. Agents execute low-risk work; the owner reviews the result. Production release,
rollback, secrets, database migrations, and destructive actions always require a separate
explicit human approval.

## Canonical flow

1. Authenticate and deduplicate the Feishu event.
2. Store the original requirement as the root task.
3. Build a dependency-aware task plan and assign every task to a registered capability.
4. Execute each task in an isolated branch or worktree with a bounded file scope.
5. Store planning checkpoints, artifacts, test evidence, reviews, and failures while the
   existing Hermes job aggregate remains the only execution state machine.
6. Create a Draft PR and Preview deployment after all automatic gates pass.
7. Send one final review packet to the owner in Feishu.
8. After human approval, merge through the protected branch workflow.
9. Record the reviewed outcome as project memory for later planning and retrospectives.

## Sources of truth

- GitHub `develop`: current development integration source.
- GitHub `production`: only Production Git release source.
- Supabase Hermes V2 tables: requirements, plans, evidence, approvals, and memory.
- Supabase `hermes_jobs`, `hermes_job_attempts`, and `hermes_job_leases`: the only Worker
  execution state machine.
- GitHub Actions: deterministic test and policy gates.
- Vercel: Preview and Production deployment state.
- Feishu: owner request, progress summary, decision request, and final review surface.

Feishu messages are not the canonical task database. Agent chat context is not durable
workflow state. Git branches are not a substitute for task or approval records.

## Control-plane data model

The versioned Hermes V2 migration creates additive tables for:

- projects and dependency-aware tasks;
- registered logical agents and planning checkpoints;
- human decisions and deployment observations;
- append-oriented task events and a Feishu sync outbox;
- immutable artifact references and structured reviews;
- reviewed project memory and retrospective learning.

The public intake RPC stores a requirement and its complete plan in one transaction.
Feishu event identifiers and plan task keys provide idempotency. Internal helper RPCs use
the same schema contract. RLS is enabled with no public policies; only the server-side
service role can call the RPCs.

V2 planning tasks may link to one `canonical_hermes_job_id`. V2 does not claim work and
does not own attempt, lease, heartbeat, progress, retry, or terminal execution state. This
prevents a second state machine from disagreeing with the existing Worker aggregate.

The production database may contain the earlier `hermes_v2_task_attempts` draft and its
historical rows. The versioned migration preserves those rows as audit evidence, adds and
backfills `canonical_hermes_job_id` from valid legacy job links, and never dispatches new
work through the legacy table.

## Runtime modes

`HERMES_AUTONOMOUS_FACTORY_MODE` has three fail-closed values:

- `disabled` (default): current production behavior, with no V2 calls.
- `shadow`: persist the V2 requirement and plan while the existing workflow remains
  authoritative. A V2 failure is recorded with a fixed safe code and does not interrupt
  the existing path.
- `authoritative`: a V2 persistence failure aborts processing with a fixed safe error.
  This mode must remain off until the migration and shadow evidence have been reviewed.

Unknown values are rejected. Database details, message contents, credentials, and
connection strings must not be written to logs.

## Agent registry

The business roles remain the familiar project director, product, UI, interaction,
frontend, backend, testing, and operations roles. The unified registry maps each role to
capabilities and to a real executable runtime. Today that runtime is Codex for every role;
the capability label controls prompts and policy, not a fictional process.

Operations work has a production approval gate. All other roles can be configured for a
single final owner review after automatic tests and Preview verification pass.

## Activation sequence

1. Review and manually apply the Feishu receipt migration.
2. Review and manually apply the Hermes V2 control-plane migration.
3. Verify tables, RLS, indexes, functions, and existing data without reading message bodies.
4. Set the mode to `shadow` in Preview only.
5. Submit synthetic, non-sensitive Feishu requirements and compare V1/V2 plans.
6. Add the task dispatcher, isolated executor, evidence collector, and final-review packet.
7. Exercise failure recovery, duplicate delivery, lease expiry, and rollback drills.
8. Enable `shadow` in Production and observe it before any authoritative cutover.
9. Obtain explicit approval before setting `authoritative` or enabling automated merges.

## Non-negotiable gates

- No agent may write secrets or echo them into logs.
- No agent may execute a migration or production release without explicit approval.
- No task may edit outside its approved path set.
- A failed or missing test is never converted into success.
- Every result must link its planning task to the canonical Hermes job, attempt, commit,
  checks, Preview, and review evidence.
- Memory is written only from reviewed outcomes; raw model guesses are not promoted to
  durable project guidance.
