# One-Time Canary Owner Identity Receipt

## Scope

The identity receipt is a narrow bridge from an authenticated Feishu callback to a future owner-only Canary policy transaction. It adds exactly:

- `public.hermes_canary_owner_identity_receipts`
- `public.capture_canary_owner_identity_receipt(text,text,text)`
- `public.audit_canary_owner_identity_receipt(uuid,text,text)`

It does not create a challenge, policy, admission, job, conversation, message, attempt, lease, or terminal. It does not enable Canonical features.

## Trust Boundary

The reserved command is:

```text
总管 身份验证 <64-character-lowercase-hex-256-bit-nonce>
```

The Application examines it only after `prepareFeishuCallbackAcceptance` has verified the Gateway-to-Application boundary, Feishu callback signature, payload decryption, verification token, and event identity. The owner authority is only:

```text
accepted.payload.event.sender.sender_id.open_id
```

The command nonce proves operator intent. It never supplies owner identity.

The route handles any exact reserved namespace before `next/server.after()` registration. A malformed command, wrong/expired/consumed nonce, unsupported chat type, non-user sender, RPC failure, timeout, or unknown RPC result receives the same transport acknowledgement and cannot enter Legacy or Canonical routing. The supported chat types are Feishu `p2p` and `group`; both still use the verified Feishu user sender as the owner authority and the one-time nonce as operator intent.

## Data Security

- The database stores only `SHA256(raw_nonce)`, never the raw nonce.
- The capture RPC computes owner and event hashes from verified raw values inside the postgres-owned function.
- Raw owner identity can exist only while a receipt is `CAPTURED` and unconsumed.
- `CONSUMED` and `RETIRED` require `owner_open_id IS NULL`.
- The receipt table has RLS enabled, no policies, and no direct access for Application `service_role` or the audit reader.
- Application `service_role` can execute only the capture RPC.
- The audit reader can execute only the exact-scope, hash-only audit function.
- Logs contain reason code, receipt identity, nonce hash, owner hash, and event hash only.

## D-F6 Challenge Creation Contract

D-F6 must generate a fresh 256-bit nonce with a trusted local cryptographic random source. Show the raw nonce to the operator once. Do not save it in SQL, logs, source, docs, or reports. Compute its lowercase SHA-256 locally and provide only that hash to the owner transaction.

The future owner package must substitute only approved receipt and nonce-hash parameters. It must not be run as part of this migration.

```sql
begin;

do $owner_gate$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'IDENTITY_CHALLENGE_OWNER_REQUIRED';
  end if;

  if exists (
    select 1
    from public.hermes_canary_owner_identity_receipts
    where purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
      and status in ('PENDING', 'CAPTURED')
  ) then
    raise exception 'ACTIVE_IDENTITY_CHALLENGE_ALREADY_EXISTS';
  end if;
end
$owner_gate$;

insert into public.hermes_canary_owner_identity_receipts (
  receipt_id,
  purpose,
  nonce_sha256,
  status,
  challenge_created_at,
  challenge_expires_at
) values (
  pg_catalog.gen_random_uuid(),
  'CANARY_OWNER_IDENTITY_DISCOVERY_V1',
  '<approved-lowercase-sha256-of-fresh-raw-nonce>',
  'PENDING',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp() + interval '600 seconds'
);

commit;
```

The partial unique index on `purpose` is the database authority for at most one `PENDING` or `CAPTURED` receipt.

## D-F6-A Pending Verification

The audit reader calls the audit function with exact `receipt_id`, purpose, and nonce hash. Expected state before the operator sends the command:

```text
status=PENDING
raw_owner_present=false
challenge_expired=false
owner_open_id_sha256=NULL
verified_event_id_sha256=NULL
```

No list, latest, wildcard, or prefix lookup exists.

## Expired Capture Retirement

If a captured receipt reaches its 900-second deadline before policy consumption, all later stages remain blocked until a postgres owner executes an exact retirement transaction. The receipt and hash evidence remain; only raw owner identity is cleared.

```sql
begin;

update public.hermes_canary_owner_identity_receipts
set
  status = 'RETIRED',
  owner_open_id = null
where receipt_id = '<exact-approved-receipt-id>'::uuid
  and purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
  and nonce_sha256 = '<exact-approved-nonce-sha256>'
  and status = 'CAPTURED'
  and receipt_expires_at <= pg_catalog.clock_timestamp()
  and owner_open_id is not null;

do $retirement_postcheck$
begin
  if not exists (
    select 1
    from public.hermes_canary_owner_identity_receipts
    where receipt_id = '<exact-approved-receipt-id>'::uuid
      and status = 'RETIRED'
      and owner_open_id is null
  ) then
    raise exception 'IDENTITY_RECEIPT_RETIREMENT_FAILED';
  end if;
end
$retirement_postcheck$;

commit;
```

Broad updates are forbidden.

## D1 Atomic Policy Consumption

D1 must never place raw owner identity in an Owner SQL literal or report. The postgres transaction locks the exact unexpired receipt, inserts the policy from `receipt.owner_open_id` inside the database, and clears the raw value in the same transaction.

```sql
begin;

with locked_receipt as (
  select receipt_id, owner_open_id, owner_open_id_sha256
  from public.hermes_canary_owner_identity_receipts
  where receipt_id = '<exact-approved-receipt-id>'::uuid
    and purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'
    and nonce_sha256 = '<exact-approved-nonce-sha256>'
    and status = 'CAPTURED'
    and receipt_expires_at > pg_catalog.clock_timestamp()
    and owner_open_id is not null
    and consumed_at is null
  for update
), inserted_policy as (
  insert into public.hermes_canonical_canary_policy_rules (
    policy_id,
    owner_open_id,
    batch_code,
    requested_mode,
    enabled
  )
  select
    '<approved-policy-id>',
    owner_open_id,
    '<approved-batch-code>',
    'worker_read_only',
    true
  from locked_receipt
  returning policy_id
)
update public.hermes_canary_owner_identity_receipts receipt
set
  status = 'CONSUMED',
  owner_open_id = null,
  consumed_at = pg_catalog.clock_timestamp(),
  consumed_policy_id = inserted_policy.policy_id
from inserted_policy
where receipt.receipt_id = '<exact-approved-receipt-id>'::uuid;

-- The controlled D1 package must add exact row-count, hash, and zero-admission/job postconditions here.

commit;
```

If the receipt is expired, missing, already consumed, or does not match the approved exact scope, zero policy rows are inserted and the D1 wrapper must raise and roll back.

## Rollback

Before any challenge exists, rollback is limited to the three additive objects:

```sql
begin;
drop function public.audit_canary_owner_identity_receipt(uuid,text,text);
drop function public.capture_canary_owner_identity_receipt(text,text,text);
drop table public.hermes_canary_owner_identity_receipts;
commit;
```

Rollback must not touch Canonical admission objects, Hermes job tables, existing audit functions, roles, or business-table RLS.

## Required Stage Order

1. D-F3 implementation
2. D-F3-A independent audit
3. D-F4 controlled database migration
4. D-F4-A database post-migration verification
5. D-F5 staged Application rollout
6. D-F5-A runtime verification
7. D-F6 owner challenge creation
8. D-F6-A pending receipt verification
9. D-F7 controlled fresh Feishu identity callback
10. D-F7-A captured receipt verification
11. D1 atomic Canary policy transaction
12. D1-A policy verification

No identity-discovery callback is permitted before D-F6-A passes.
