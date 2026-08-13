param(
  [string]$PostgresBin = $env:POSTGRES_BIN,
  [string]$ExistingDataDir = '',
  [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $PostgresBin) {
  $PostgresBin = Split-Path -Parent (Get-Command initdb -ErrorAction Stop).Source
}

$initdb = Join-Path $PostgresBin 'initdb.exe'
$postgres = Join-Path $PostgresBin 'postgres.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
$migration = Join-Path $repoRoot 'supabase\migrations\202608140001_canary_owner_identity_receipt.sql'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$fixtureRoot = Join-Path $workspaceRoot '.tmp-pg18'
$dataDir = if ($ExistingDataDir) {
  (Resolve-Path -LiteralPath $ExistingDataDir).Path
} else {
  Join-Path $fixtureRoot ("identity-receipt-pg18-{0}" -f [Guid]::NewGuid().ToString('N'))
}
$postgresProcess = $null
$started = $false
$checks = 0

function Assert-Equal {
  param([object]$Actual, [object]$Expected, [string]$Name)
  if ($Actual -ne $Expected) {
    throw "CHECK_FAILED: $Name expected=[$Expected] actual=[$Actual]"
  }
  $script:checks++
}

function Assert-True {
  param([bool]$Condition, [string]$Name)
  if (-not $Condition) { throw "CHECK_FAILED: $Name" }
  $script:checks++
}

function Invoke-Psql {
  param([string]$Sql, [string]$Database = 'postgres')
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d $Database -At -c $Sql 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($exitCode -ne 0) { throw ($output -join "`n") }
  return ($output -join "`n").Trim()
}

function Invoke-PsqlFile {
  param([string]$Path, [string]$Database = 'postgres')
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d $Database -f $Path 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($exitCode -ne 0) { throw ($output -join "`n") }
  return ($output -join "`n").Trim()
}

function Invoke-PsqlFileExpectFailure {
  param([string]$Database, [string]$Name)
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d $Database -f $migration 2>&1 | Out-Null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $saved
  Assert-True ($exitCode -ne 0) $Name
}

function Initialize-RolesAndExtension {
  param([string]$Database, [bool]$IncludeDigest = $true, [bool]$IncludeReader = $true)
  Invoke-Psql @'
do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname='authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname='service_role') then create role service_role nologin; end if;
end
$roles$;
revoke create on schema public from public;
'@ $Database | Out-Null
  if ($IncludeReader) {
    Invoke-Psql @'
do $reader$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname='production_schema_audit_reader') then
    create role production_schema_audit_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$reader$;
'@ $Database | Out-Null
  }
  if ($IncludeDigest) {
    Invoke-Psql 'create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;' $Database | Out-Null
  }
}

function New-FixtureDatabase {
  param([string]$Name, [bool]$IncludeDigest = $true, [bool]$IncludeReader = $true)
  Invoke-Psql "create database $Name" | Out-Null
  Initialize-RolesAndExtension $Name $IncludeDigest $IncludeReader
}

function Quote-Sql {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-Sha256 {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Set-Phase {
  param([string]$Name)
  if ($ResultPath) { "PHASE=$Name" | Set-Content -LiteralPath $ResultPath -Encoding ascii }
}

try {
  Set-Phase 'INITDB'
  $env:PG_RESTRICT_EXEC = '1'
  if (-not $ExistingDataDir) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    & $initdb -D $dataDir -U postgres -A trust --no-locale --encoding=UTF8 --no-sync --no-instructions | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
  }

  Set-Phase 'START_POSTGRES'
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $postgres
  $startInfo.Arguments = '-D "' + $dataDir + '" -p ' + $port + ' -h 127.0.0.1'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $postgresProcess = [Diagnostics.Process]::Start($startInfo)
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    if ($postgresProcess.HasExited) { throw "postgres exited: $($postgresProcess.ExitCode)" }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $psql -X -h 127.0.0.1 -p $port -U postgres -d postgres -At -c 'select 1' 2>$null | Out-Null
    $ready = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $saved
  } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if (-not $ready) { throw 'postgres startup timed out' }
  $started = $true

  Set-Phase 'PRECONDITION_NEGATIVE_TESTS'
  New-FixtureDatabase 'missing_reader' $true $false
  Invoke-PsqlFileExpectFailure 'missing_reader' 'missing_reader_blocks_migration'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is null" 'missing_reader') 't' 'missing_reader_transaction_rolled_back'

  New-FixtureDatabase 'missing_digest' $false $true
  Invoke-PsqlFileExpectFailure 'missing_digest' 'missing_digest_blocks_migration'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is null" 'missing_digest') 't' 'missing_digest_transaction_rolled_back'

  New-FixtureDatabase 'target_conflict'
  Invoke-Psql 'create table public.hermes_canary_owner_identity_receipts(id integer)' 'target_conflict' | Out-Null
  Invoke-PsqlFileExpectFailure 'target_conflict' 'target_table_conflict_blocks_migration'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.capture_canary_owner_identity_receipt(text,text,text)') is null" 'target_conflict') 't' 'target_conflict_function_absent'

  Set-Phase 'CLEAN_INSTALL'
  Initialize-RolesAndExtension 'postgres'
  Invoke-PsqlFile $migration | Out-Null

  Assert-Equal (Invoke-Psql "select version() like 'PostgreSQL 18.%'") 't' 'postgres_version_18'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is not null") 't' 'receipt_table_exists'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.capture_canary_owner_identity_receipt(text,text,text)') is not null") 't' 'capture_function_exists'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.audit_canary_owner_identity_receipt(uuid,text,text)') is not null") 't' 'audit_function_exists'
  Assert-Equal (Invoke-Psql "select count(*) from public.hermes_canary_owner_identity_receipts") '0' 'migration_seed_count_zero'
  Assert-Equal (Invoke-Psql "select c.relrowsecurity,c.relforcerowsecurity from pg_catalog.pg_class c where c.oid='public.hermes_canary_owner_identity_receipts'::regclass") 't|f' 'table_rls_enabled'
  Assert-Equal (Invoke-Psql "select count(*) from pg_catalog.pg_policy where polrelid='public.hermes_canary_owner_identity_receipts'::regclass") '0' 'table_rls_policy_count_zero'

  Assert-Equal (Invoke-Psql @'
select pg_catalog.pg_get_userbyid(p.proowner),l.lanname,p.provolatile,p.prosecdef,
  p.proconfig=array['search_path=pg_catalog']
from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
where p.oid='public.capture_canary_owner_identity_receipt(text,text,text)'::regprocedure
'@) 'postgres|plpgsql|v|t|t' 'capture_catalog_contract'
  Assert-Equal (Invoke-Psql @'
select pg_catalog.pg_get_userbyid(p.proowner),l.lanname,p.provolatile,p.prosecdef,
  p.proconfig=array['search_path=pg_catalog']
from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
where p.oid='public.audit_canary_owner_identity_receipt(uuid,text,text)'::regprocedure
'@) 'postgres|sql|s|t|t' 'audit_catalog_contract'

  Assert-Equal (Invoke-Psql @'
select
  pg_catalog.has_function_privilege('service_role','public.capture_canary_owner_identity_receipt(text,text,text)','EXECUTE'),
  pg_catalog.has_function_privilege('production_schema_audit_reader','public.capture_canary_owner_identity_receipt(text,text,text)','EXECUTE'),
  pg_catalog.has_function_privilege('service_role','public.audit_canary_owner_identity_receipt(uuid,text,text)','EXECUTE'),
  pg_catalog.has_function_privilege('production_schema_audit_reader','public.audit_canary_owner_identity_receipt(uuid,text,text)','EXECUTE')
'@) 't|f|f|t' 'function_acl_contract'
  Assert-Equal (Invoke-Psql @'
select pg_catalog.has_table_privilege('service_role','public.hermes_canary_owner_identity_receipts','SELECT,INSERT,UPDATE,DELETE'),
  pg_catalog.has_table_privilege('production_schema_audit_reader','public.hermes_canary_owner_identity_receipts','SELECT,INSERT,UPDATE,DELETE')
'@) 'f|f' 'direct_table_acl_contract'
  Assert-Equal (Invoke-Psql @'
select exists(
  select 1 from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where a.grantee=0
)
from pg_catalog.pg_class c where c.oid='public.hermes_canary_owner_identity_receipts'::regclass
'@) 'f' 'public_table_acl_false'

  $badInsertCases = @(
    "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values(gen_random_uuid(),'WRONG','$(('a' * 64))','PENDING',now(),now()+interval '10 minutes')",
    "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values(gen_random_uuid(),'CANARY_OWNER_IDENTITY_DISCOVERY_V1','ABC','PENDING',now(),now()+interval '10 minutes')",
    "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values(gen_random_uuid(),'CANARY_OWNER_IDENTITY_DISCOVERY_V1','$(('b' * 64))','WRONG',now(),now()+interval '10 minutes')",
    "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values(gen_random_uuid(),'CANARY_OWNER_IDENTITY_DISCOVERY_V1','$(('c' * 64))','PENDING',now(),now())",
    "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at,owner_open_id) values(gen_random_uuid(),'CANARY_OWNER_IDENTITY_DISCOVERY_V1','$(('d' * 64))','PENDING',now(),now()+interval '10 minutes','ou_invalid')"
  )
  foreach ($sql in $badInsertCases) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d postgres -At -c $sql 2>&1 | Out-Null
    $failed = $LASTEXITCODE -ne 0
    $ErrorActionPreference = $saved
    Assert-True $failed 'invalid_receipt_shape_rejected'
  }

  Set-Phase 'CAPTURE_SEMANTICS'
  $rawNonce = 'synthetic-nonce-alpha'
  $nonceHash = Get-Sha256 $rawNonce
  $owner = 'ou_synthetic_owner_alpha'
  $event = 'evt_synthetic_alpha'
  $ownerHash = Get-Sha256 $owner
  $eventHash = Get-Sha256 $event
  $receiptId = [Guid]::NewGuid().ToString()
  Invoke-Psql "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash','PENDING',clock_timestamp(),clock_timestamp()+interval '600 seconds')" | Out-Null
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select status,raw_owner_present from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash')") 'PENDING|f' 'pending_audit_state'
  $capture = Invoke-Psql "set role service_role; select receipt_id,capture_outcome,owner_open_id_sha256,verified_event_id_sha256 from public.capture_canary_owner_identity_receipt('$nonceHash',$(Quote-Sql $owner),$(Quote-Sql $event))"
  Assert-Equal $capture "$receiptId|CAPTURED|$ownerHash|$eventHash" 'valid_capture_succeeds'
  $firstTimes = Invoke-Psql "select captured_at::text||'|'||receipt_expires_at::text from public.hermes_canary_owner_identity_receipts where receipt_id='$receiptId'"
  $retry = Invoke-Psql "set role service_role; select receipt_id,capture_outcome from public.capture_canary_owner_identity_receipt('$nonceHash',$(Quote-Sql $owner),$(Quote-Sql $event))"
  Assert-Equal $retry "$receiptId|IDEMPOTENT_ALREADY_CAPTURED" 'same_event_retry_idempotent'
  Assert-Equal (Invoke-Psql "select captured_at::text||'|'||receipt_expires_at::text from public.hermes_canary_owner_identity_receipts where receipt_id='$receiptId'") $firstTimes 'retry_does_not_extend_ttl'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$nonceHash',$(Quote-Sql $owner),'evt_other')") 'DENIED' 'different_event_same_nonce_denied'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$nonceHash','ou_other',$(Quote-Sql $event))") 'DENIED' 'same_event_different_owner_denied'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('BAD',$(Quote-Sql $owner),$(Quote-Sql $event))") 'DENIED' 'malformed_nonce_denied'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$nonceHash','',$(Quote-Sql $event))") 'DENIED' 'empty_owner_denied'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$nonceHash',$(Quote-Sql $owner),'')") 'DENIED' 'empty_event_denied'
  Assert-Equal (Invoke-Psql "select status,owner_open_id,owner_open_id_sha256,verified_event_id_sha256 from public.hermes_canary_owner_identity_receipts where receipt_id='$receiptId'") "CAPTURED|$owner|$ownerHash|$eventHash" 'conflicts_do_not_overwrite_capture'
  Assert-Equal (Invoke-Psql "select extract(epoch from (receipt_expires_at-captured_at))::integer from public.hermes_canary_owner_identity_receipts where receipt_id='$receiptId'") '900' 'captured_ttl_exact_900'

  Set-Phase 'AUDIT_LIFECYCLE'
  $auditExact = Invoke-Psql "set role production_schema_audit_reader; select status,owner_open_id_sha256,verified_event_id_sha256,raw_owner_present from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash')"
  Assert-Equal $auditExact "CAPTURED|$ownerHash|$eventHash|t" 'captured_audit_hash_only'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$(('f' * 64))')") '0' 'wrong_nonce_zero_rows'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt(gen_random_uuid(),'CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash')") '0' 'wrong_receipt_zero_rows'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt('$receiptId','WRONG','$nonceHash')") '0' 'wrong_purpose_zero_rows'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt(null,'CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash')") '0' 'null_receipt_zero_rows'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','')") '0' 'empty_hash_zero_rows'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select count(*) from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$(('A' * 64))')") '0' 'uppercase_hash_zero_rows'

  Invoke-Psql "update public.hermes_canary_owner_identity_receipts set status='RETIRED',owner_open_id=null where receipt_id='$receiptId' and status='CAPTURED'" | Out-Null
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select status,raw_owner_present from public.audit_canary_owner_identity_receipt('$receiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$nonceHash')") 'RETIRED|f' 'retirement_clears_raw_owner'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$(Get-Sha256 'never-created')','ou_none','evt_none')") 'DENIED' 'no_active_challenge_denied'

  $expiredChallengeHash = Get-Sha256 'synthetic-expired-challenge'
  $expiredChallengeId = [Guid]::NewGuid().ToString()
  Invoke-Psql "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values('$expiredChallengeId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$expiredChallengeHash','PENDING',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '10 minutes')" | Out-Null
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$expiredChallengeHash','ou_expired_challenge','evt_expired_challenge')") 'DENIED' 'expired_challenge_denied'
  Invoke-Psql "update public.hermes_canary_owner_identity_receipts set status='RETIRED' where receipt_id='$expiredChallengeId' and status='PENDING'" | Out-Null

  Set-Phase 'CONCURRENT_CAPTURE'
  $raceNonceHash = Get-Sha256 'synthetic-race-nonce'
  $raceReceiptId = [Guid]::NewGuid().ToString()
  Invoke-Psql "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values('$raceReceiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$raceNonceHash','PENDING',clock_timestamp(),clock_timestamp()+interval '600 seconds')" | Out-Null
  $raceProcesses = @()
  for ($i = 1; $i -le 2; $i++) {
    $sql = "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$raceNonceHash','ou_race_$i','evt_race_$i')"
    $args = @('-X','-q','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',"$port",'-U','postgres','-d','postgres','-At','-c',$sql)
    $raceStart = [Diagnostics.ProcessStartInfo]::new()
    $raceStart.FileName = $psql
    $raceStart.UseShellExecute = $false
    $raceStart.CreateNoWindow = $true
    $raceStart.RedirectStandardOutput = $true
    $raceStart.RedirectStandardError = $true
    $raceStart.Arguments = (($args | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
    $raceProcesses += [Diagnostics.Process]::Start($raceStart)
  }
  $raceResults = @()
  $raceProcesses | ForEach-Object {
    $stdout = $_.StandardOutput.ReadToEnd().Trim()
    $stderr = $_.StandardError.ReadToEnd().Trim()
    $_.WaitForExit()
    Assert-Equal $_.ExitCode 0 "concurrent_psql_exit_zero stderr=$stderr"
    $raceResults += $stdout
  }
  Assert-Equal (($raceResults | Where-Object { $_ -eq 'CAPTURED' }).Count) 1 'concurrent_capture_winner_count'
  Assert-Equal (($raceResults | Where-Object { $_ -eq 'DENIED' }).Count) 1 'concurrent_capture_loser_count'
  Assert-Equal (Invoke-Psql "select count(*) from public.hermes_canary_owner_identity_receipts where receipt_id='$raceReceiptId' and status='CAPTURED'") '1' 'concurrent_single_captured_row'
  Invoke-Psql "update public.hermes_canary_owner_identity_receipts set status='RETIRED',owner_open_id=null where receipt_id='$raceReceiptId'" | Out-Null

  Set-Phase 'FUTURE_POLICY_CONSUME'
  Invoke-Psql @'
create table public.synthetic_canary_policy(
  policy_id text primary key,
  owner_open_id text not null
);
'@ | Out-Null
  $consumeNonceHash = Get-Sha256 'synthetic-consume-nonce'
  $consumeReceiptId = [Guid]::NewGuid().ToString()
  Invoke-Psql "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at) values('$consumeReceiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$consumeNonceHash','PENDING',clock_timestamp(),clock_timestamp()+interval '600 seconds')" | Out-Null
  Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$consumeNonceHash','ou_consume_owner','evt_consume')" | Out-Null
  Invoke-Psql @"
begin;
with locked as (
  select receipt_id,owner_open_id
  from public.hermes_canary_owner_identity_receipts
  where receipt_id='$consumeReceiptId'
    and status='CAPTURED'
    and receipt_expires_at > pg_catalog.clock_timestamp()
    and owner_open_id is not null
    and consumed_at is null
  for update
), inserted as (
  insert into public.synthetic_canary_policy(policy_id,owner_open_id)
  select 'CANARY-SYNTHETIC-CONSUME',owner_open_id from locked
  returning policy_id
)
update public.hermes_canary_owner_identity_receipts r
set status='CONSUMED',owner_open_id=null,consumed_at=pg_catalog.clock_timestamp(),consumed_policy_id=i.policy_id
from inserted i where r.receipt_id='$consumeReceiptId';
commit;
"@ | Out-Null
  Assert-Equal (Invoke-Psql "select owner_open_id from public.synthetic_canary_policy where policy_id='CANARY-SYNTHETIC-CONSUME'") 'ou_consume_owner' 'policy_consumed_raw_inside_database'
  Assert-Equal (Invoke-Psql "select status,owner_open_id is null,consumed_policy_id from public.hermes_canary_owner_identity_receipts where receipt_id='$consumeReceiptId'") 'CONSUMED|t|CANARY-SYNTHETIC-CONSUME' 'policy_consume_clears_raw_atomically'
  Assert-Equal (Invoke-Psql "set role production_schema_audit_reader; select status,raw_owner_present from public.audit_canary_owner_identity_receipt('$consumeReceiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$consumeNonceHash')") 'CONSUMED|f' 'consumed_audit_state'
  Assert-Equal (Invoke-Psql "set role service_role; select capture_outcome from public.capture_canary_owner_identity_receipt('$consumeNonceHash','ou_consume_owner','evt_consume')") 'DENIED' 'consumed_nonce_denied'

  $expiredNonceHash = Get-Sha256 'synthetic-expired-nonce'
  $expiredReceiptId = [Guid]::NewGuid().ToString()
  $expiredOwner = 'ou_expired_owner'
  $expiredEvent = 'evt_expired'
  Invoke-Psql "insert into public.hermes_canary_owner_identity_receipts(receipt_id,purpose,nonce_sha256,status,challenge_created_at,challenge_expires_at,owner_open_id,owner_open_id_sha256,verified_event_id_sha256,captured_at,receipt_expires_at) values('$expiredReceiptId','CANARY_OWNER_IDENTITY_DISCOVERY_V1','$expiredNonceHash','CAPTURED',clock_timestamp()-interval '30 minutes',clock_timestamp()-interval '20 minutes','$expiredOwner','$(Get-Sha256 $expiredOwner)','$(Get-Sha256 $expiredEvent)',clock_timestamp()-interval '16 minutes',clock_timestamp()-interval '1 minute')" | Out-Null
  Assert-Equal (Invoke-Psql "select count(*) from public.hermes_canary_owner_identity_receipts where receipt_id='$expiredReceiptId' and status='CAPTURED' and receipt_expires_at>clock_timestamp()") '0' 'expired_receipt_not_consumable'
  Assert-Equal (Invoke-Psql "select count(*) from public.synthetic_canary_policy where owner_open_id='$expiredOwner'") '0' 'expired_owner_not_inserted_to_policy'
  Invoke-Psql "update public.hermes_canary_owner_identity_receipts set status='RETIRED',owner_open_id=null where receipt_id='$expiredReceiptId' and status='CAPTURED' and receipt_expires_at<=clock_timestamp() and owner_open_id is not null" | Out-Null
  Assert-Equal (Invoke-Psql "select status,owner_open_id is null from public.hermes_canary_owner_identity_receipts where receipt_id='$expiredReceiptId'") 'RETIRED|t' 'expired_retirement_contract'

  Set-Phase 'ROLLBACK_AND_REEXECUTION'
  Invoke-PsqlFileExpectFailure 'postgres' 'migration_reexecution_fails_closed'
  Assert-Equal (Invoke-Psql "select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('capture_canary_owner_identity_receipt','audit_canary_owner_identity_receipt')") '2' 'reexecution_does_not_replace_functions'

  New-FixtureDatabase 'rollback_fixture'
  Invoke-PsqlFile $migration 'rollback_fixture' | Out-Null
  Invoke-Psql @'
begin;
drop function public.audit_canary_owner_identity_receipt(uuid,text,text);
drop function public.capture_canary_owner_identity_receipt(text,text,text);
drop table public.hermes_canary_owner_identity_receipts;
commit;
'@ 'rollback_fixture' | Out-Null
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regclass('public.hermes_canary_owner_identity_receipts') is null" 'rollback_fixture') 't' 'rollback_table_absent'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.capture_canary_owner_identity_receipt(text,text,text)') is null" 'rollback_fixture') 't' 'rollback_capture_absent'
  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.audit_canary_owner_identity_receipt(uuid,text,text)') is null" 'rollback_fixture') 't' 'rollback_audit_absent'

  Set-Phase 'COMPLETE'
  $summary = "IDENTITY_RECEIPT_POSTGRES18_PASS checks=$checks concurrent_attempts=2 concurrent_winners=1"
  if ($ResultPath) { $summary | Set-Content -LiteralPath $ResultPath -Encoding ascii }
  Write-Output $summary
}
finally {
  if ($started -and $postgresProcess -and -not $postgresProcess.HasExited) {
    $postgresProcess.Kill()
    $postgresProcess.WaitForExit()
  }
  if (-not $ExistingDataDir -and (Test-Path -LiteralPath $dataDir)) {
    Remove-Item -LiteralPath $dataDir -Recurse -Force
  }
}
