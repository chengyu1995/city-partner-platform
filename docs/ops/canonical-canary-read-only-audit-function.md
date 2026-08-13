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

## Owner package

The migration file itself is the owner execution package draft. It contains a
single transaction with identity, role, extension, table, column, function
identity, and ACL checks. A future controlled Production batch must lock its
SHA-256 and independently audit the exact bytes before an owner runs it once.

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
