# Canonical Migration Audit Requirements

Production migration approval requires an independent, read-only inspection of the target PostgreSQL schema before any migration is executed.

## Required metadata

The auditor must be able to read:

- `information_schema.tables` and `information_schema.columns`
- `pg_catalog.pg_constraint`
- `pg_catalog.pg_indexes`
- `pg_catalog.pg_proc`
- function and schema ACL metadata

The inspection must verify existing columns, types, defaults, nullability, constraints, indexes, function signatures, `SECURITY DEFINER` settings, fixed `search_path` values, and execute privileges. It must also collect enough table-size metadata to assess lock duration for constraint validation and index creation.

## Access boundary

Audit access is read-only. It must not grant, revoke, or otherwise change production permissions. It must not execute DDL, DML, migrations, maintenance commands, or application state transitions.

Credentials, connection strings, tokens, and secret values must never appear in audit output. If the required catalog and ACL metadata cannot be read, the audit must fail closed and production migration approval must remain blocked.
