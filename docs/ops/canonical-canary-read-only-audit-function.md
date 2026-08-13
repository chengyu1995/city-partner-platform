# Canonical Canary read-only audit function

## Scope

`202608130001_canonical_canary_read_only_audit_function.sql` adds one read-only
audit function. It does not alter table privileges, RLS policies, runtime write
functions, feature flags, or application code.

The function is intentionally the only new privilege boundary:

- owner: `postgres`
- language: `sql`
- volatility: `STABLE`
- execution: `SECURITY DEFINER`
- search path: `pg_catalog`
- executable role: `production_schema_audit_reader` only

All table names use the `public` schema explicitly. SHA-256 uses
`extensions.digest` explicitly. The function contains no dynamic SQL or
mutation statement.

Every visible job is admission-bound. Scope jobs are reached through
`scope_admissions.job_id`; event jobs are reached through
`matching_admissions.job_id`. Owner, event, or mode hashes never authorize a
direct scan of `hermes_jobs`, and a null admission `job_id` cannot fall back to
an event lookup.

Before creating the function, the migration verifies that all seven source
objects are ordinary tables and that all 30 referenced columns match the
Production formatted type and required nullability contract. It also verifies
the exact `extensions.digest(text,text) -> bytea` dependency and required
roles.

## Owner package

The migration is transactional input to a future owner execution package; it
is not the final C2 package by itself. C2 must wrap the independently approved
exact SHA-256 with Production identity checks, pre/post evidence capture, and
rollback instructions before an owner runs it once.

Do not run the migration from an application credential or service-role API.
Do not add policy, admission, job, attempt, lease, terminal, or result fixture
rows in Production.

## Audit lookup

The caller computes lowercase SHA-256 values outside PostgreSQL and supplies
the exact approved scope:

```sql
select *
from public.audit_canonical_canary_scope_state(
  '<policy-id>',
  '<owner-open-id-sha256>',
  '<batch-code-sha256>',
  'worker_read_only',
  '<event-id-sha256>'
);
```

Invalid or incomplete scope input returns one zero-state row with
`scope_input_valid=false`. It does not raise an identity-bearing error.

The output omits raw owner, event, message, and request identifiers. It also
omits request text, result payloads, terminal reports, output, file lists,
secrets, and credentials. `attempt_ids` and `lease_ids` are `text[]` because
that is their Production schema type; `terminal_ids` is `uuid[]`.

## Independent verification

After a future owner transaction commits, establish a fresh
`production_audit` connection and verify:

1. `current_user` and `session_user` are `production_schema_audit_reader`.
2. Role-level read-only and timeout settings remain hardened.
3. The function owner, language, volatility, security mode, and search path
   match the contract above.
4. PUBLIC, `anon`, `authenticated`, `authenticator`, and `service_role` lack
   `EXECUTE`; the audit reader has `EXECUTE`.
5. The reader still lacks direct `SELECT` on the two Canary tables and has no
   write privilege on any audited table.
6. A nonexistent valid scope returns zero counts.
7. An invalid hash returns `scope_input_valid=false` and zero counts.
8. No function call contains a raw identifier; only precomputed hashes are
   supplied.

Do not call any write RPC as part of verification.

Local verification uses both static Node tests and a clean PostgreSQL 18
fixture. The fixture includes cross-policy, cross-batch, cross-owner,
different-event, true-positive duplicate-job, missing dependency, conflicting
function, wrong relation kind, missing object, missing column, wrong type, and
wrong nullability cases.

## Rollback

Rollback changes only the additive function:

```sql
begin;

drop function if exists
  public.audit_canonical_canary_scope_state(text, text, text, text, text);

commit;
```

Rollback must not drop the Canary tables or `canonical_admit_canary_job`, alter
RLS, restore PUBLIC execution, or change reader table privileges.
