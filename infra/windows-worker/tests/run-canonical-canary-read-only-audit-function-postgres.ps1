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
$auditMigration = Join-Path $repoRoot 'supabase\migrations\202608130001_canonical_canary_read_only_audit_function.sql'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$fixtureRoot = Join-Path $workspaceRoot '.tmp-pg18'
$dataDir = if ($ExistingDataDir) {
  (Resolve-Path -LiteralPath $ExistingDataDir).Path
} else {
  Join-Path $fixtureRoot ("hermes-audit-pg18-{0}" -f [Guid]::NewGuid().ToString('N'))
}
$logPath = Join-Path $dataDir 'postgres.log'
$started = $false
$postgresProcess = $null
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
  param([string]$Sql, [string]$User = 'postgres', [string]$Database = 'postgres')
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U $User -d $Database -At -c $Sql 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($exitCode -ne 0) { throw ($output -join "`n") }
  return ($output -join "`n").Trim()
}

function Invoke-PsqlFile {
  param([string]$Path, [string]$Database = 'postgres')
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d $Database -f $Path 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  if ($exitCode -ne 0) { throw ($output -join "`n") }
}

function Assert-Migration-Aborts {
  param([string]$Database, [string]$Name, [bool]$FunctionMustBeAbsent = $true)
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U postgres -d $Database -f $auditMigration 2>&1 | Out-Null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorActionPreference
  Assert-True ($exitCode -ne 0) "$Name`_migration_aborted"
  if ($FunctionMustBeAbsent) {
    Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.audit_canonical_canary_scope_state(text,text,text,text,text)') is null" 'postgres' $Database) 't' "$Name`_function_not_created"
  }
}

function Initialize-FixtureSchema {
  param([string]$Database, [bool]$IncludeDigest = $true)
  Invoke-Psql 'create schema extensions' 'postgres' $Database | Out-Null
  if ($IncludeDigest) {
    Invoke-Psql 'create extension pgcrypto with schema extensions' 'postgres' $Database | Out-Null
  }
  Invoke-PsqlFile (Join-Path $repoRoot 'infra\windows-worker\tests\fixtures\production-hermes-jobs-schema.sql') $Database
  Invoke-Psql @'
create table public.hermes_job_results (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  job_id uuid not null,
  output text null,
  files_changed text[] null,
  pr_url text null,
  vercel_preview text null,
  duration_ms integer null,
  created_at timestamptz null
);
alter table public.hermes_job_results enable row level security;
'@ 'postgres' $Database | Out-Null
  Invoke-PsqlFile (Join-Path $repoRoot 'supabase\migrations\202608030001_canonical_attempt_lease_foundation.sql') $Database
  Invoke-PsqlFile (Join-Path $repoRoot 'supabase\migrations\202608110001_canonical_canary_admission_control.sql') $Database
}

function Initialize-FixtureDatabase {
  param([string]$Database, [bool]$IncludeDigest = $true)
  Invoke-Psql "create database $Database" | Out-Null
  Initialize-FixtureSchema $Database $IncludeDigest
}

function Get-Sha256 {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
  }
}

function Quote-Sql {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Set-Phase {
  param([string]$Name)
  if ($ResultPath) { "PHASE=$Name" | Set-Content -LiteralPath $ResultPath -Encoding ascii }
}

try {
  Set-Phase 'PREPARE'
  if (-not $ExistingDataDir) {
    Set-Phase 'INITDB'
    New-Item -ItemType Directory -Path $dataDir | Out-Null
  }
  Set-Phase 'START_POSTGRES'
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  $env:PG_RESTRICT_EXEC = '1'
  if (-not $ExistingDataDir) {
    & $initdb -D $dataDir -U postgres -A trust --no-locale --encoding=UTF8 --no-sync --no-instructions | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $dataDir 'PG_VERSION'))) {
      throw 'initdb failed'
    }
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $postgres
  $startInfo.Arguments = '-D "' + $dataDir + '" -p ' + $port + ' -h 127.0.0.1'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $postgresProcess = [Diagnostics.Process]::Start($startInfo)
  Set-Phase 'WAIT_POSTGRES'
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 200
    if ($postgresProcess.HasExited) { throw "postgres exited during startup: $($postgresProcess.ExitCode)" }
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    & $psql -X -h 127.0.0.1 -p $port -U postgres -d postgres -At -c 'select 1' 2>$null | Out-Null
    $ready = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $savedErrorActionPreference
  } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if (-not $ready) { throw 'postgres startup timed out' }
  $started = $true
  Set-Phase 'SCHEMA_SETUP'

  Invoke-Psql @'
create role anon nologin;
create role authenticated nologin;
create role authenticator nologin;
create role service_role nologin;
'@ | Out-Null

  Initialize-FixtureDatabase 'drift_reader_missing'
  Assert-Migration-Aborts 'drift_reader_missing' 'reader_role_missing'

  Invoke-Psql @'
create role production_schema_audit_reader login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role production_schema_audit_reader set default_transaction_read_only = 'on';
alter role production_schema_audit_reader set statement_timeout = '15s';
alter role production_schema_audit_reader set lock_timeout = '3s';
'@ | Out-Null

  Initialize-FixtureSchema 'postgres'
  Invoke-Psql @'
grant select on public.hermes_jobs, public.hermes_job_attempts,
  public.hermes_job_leases, public.hermes_job_terminals,
  public.hermes_job_results to production_schema_audit_reader;
'@ | Out-Null
  Invoke-PsqlFile $auditMigration
  Set-Phase 'ASSERTIONS'

  Assert-Equal (Invoke-Psql "select pg_catalog.to_regprocedure('public.audit_canonical_canary_scope_state(text,text,text,text,text)') is not null") 't' 'function_exists'
  Assert-Equal (Invoke-Psql @'
select pg_catalog.pg_get_userbyid(p.proowner),l.lanname,p.provolatile,p.prosecdef,
  p.proconfig=array['search_path=pg_catalog']
from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
where p.oid='public.audit_canonical_canary_scope_state(text,text,text,text,text)'::regprocedure
'@) 'postgres|sql|s|t|t' 'function_catalog_contract'
  Assert-Equal (Invoke-Psql @'
select
  exists(select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'),
  pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE'),
  pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'),
  pg_catalog.has_function_privilege('authenticator',p.oid,'EXECUTE'),
  pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE'),
  pg_catalog.has_function_privilege('production_schema_audit_reader',p.oid,'EXECUTE')
from pg_catalog.pg_proc p
where p.oid='public.audit_canonical_canary_scope_state(text,text,text,text,text)'::regprocedure
'@) 'f|f|f|f|f|t' 'function_acl_contract'
  Assert-Equal (Invoke-Psql @'
select
  pg_catalog.has_table_privilege('production_schema_audit_reader','public.hermes_canonical_canary_policy_rules','SELECT'),
  pg_catalog.has_table_privilege('production_schema_audit_reader','public.hermes_canonical_canary_admissions','SELECT')
'@) 'f|f' 'no_new_canary_table_select'
  Assert-Equal (Invoke-Psql @'
select pg_catalog.bool_or(pg_catalog.has_table_privilege(
  'production_schema_audit_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (
  'hermes_canonical_canary_policy_rules','hermes_canonical_canary_admissions',
  'hermes_jobs','hermes_job_attempts','hermes_job_leases','hermes_job_terminals','hermes_job_results')
'@) 'f' 'reader_write_privileges_false'

  $owner = 'ou_fixture_owner'
  $batch = 'BATCH-FIXTURE-CANARY'
  $policy = 'CANARY-FIXTURE-01'
  $event = 'evt_fixture_01'
  $message = 'msg_fixture_01'
  $ownerHash = Get-Sha256 $owner
  $batchHash = Get-Sha256 $batch
  $eventHash = Get-Sha256 $event
  $jobId = '11111111-1111-4111-8111-111111111111'
  $admissionId = '22222222-2222-4222-8222-222222222222'
  $terminalId = '33333333-3333-4333-8333-333333333333'
  $otherOwner = 'ou_fixture_other'
  $otherBatch = 'BATCH-FIXTURE-OTHER'
  $noAdmissionPolicy = 'CANARY-FIXTURE-02'
  $multiPolicy = 'CANARY-FIXTURE-03'
  $multiBatch = 'BATCH-FIXTURE-MULTI'
  $multiJobId = '55555555-5555-4555-8555-555555555555'
  $multiAdmissionId = '66666666-6666-4666-8666-666666666666'

  function Invoke-Audit {
    param(
      [string]$Policy = $policy,
      [string]$OwnerHash = $ownerHash,
      [string]$BatchHash = $batchHash,
      [string]$Mode = 'worker_read_only',
      [string]$EventHash = $eventHash
    )
    $query = "select pg_catalog.row_to_json(s)::text from public.audit_canonical_canary_scope_state($(Quote-Sql $Policy),$(Quote-Sql $OwnerHash),$(Quote-Sql $BatchHash),$(Quote-Sql $Mode),$(Quote-Sql $EventHash)) s"
    return (Invoke-Psql $query 'production_schema_audit_reader' | ConvertFrom-Json)
  }

  function Assert-NoEventJobLeak {
    param(
      [object]$State,
      [string]$Name,
      [int]$ExpectedScopeAdmissions = 0,
      [int]$ExpectedScopeJobs = 0
    )
    Assert-Equal $State.scope_admission_count $ExpectedScopeAdmissions "$Name`_scope_admissions"
    Assert-Equal $State.matching_event_admission_count 0 "$Name`_matching_event_admissions"
    Assert-Equal $State.scope_job_count $ExpectedScopeJobs "$Name`_scope_jobs"
    Assert-Equal $State.event_job_count 0 "$Name`_event_jobs"
    Assert-Equal $State.job_id $null "$Name`_job_id"
    Assert-Equal $State.attempt_count 0 "$Name`_attempt_count"
    Assert-Equal $State.lease_count 0 "$Name`_lease_count"
    Assert-Equal $State.terminal_count 0 "$Name`_terminal_count"
    Assert-Equal $State.result_count 0 "$Name`_result_count"
    Assert-Equal $State.result_exists $false "$Name`_result_exists"
    Assert-Equal $State.duplicate_job_detected $false "$Name`_duplicate_job"
  }

  $empty = Invoke-Audit
  Assert-True $empty.scope_input_valid 'nonexistent_scope_input_valid'
  Assert-Equal $empty.policy_row_count 0 'nonexistent_policy_count'
  Assert-Equal $empty.scope_admission_count 0 'nonexistent_admission_count'
  Assert-Equal $empty.event_job_count 0 'nonexistent_job_count'

  $invalid = Invoke-Audit -OwnerHash 'NOT-A-HASH'
  Assert-Equal $invalid.scope_input_valid $false 'invalid_hash_fails_closed'
  Assert-Equal $invalid.owner_open_id_sha256 $null 'invalid_hash_not_echoed'
  Assert-Equal $invalid.job_id $null 'invalid_hash_no_job'
  $invalidMode = Invoke-Audit -Mode 'write_allowed'
  Assert-Equal $invalidMode.scope_input_valid $false 'invalid_mode_fails_closed'

  Invoke-Psql @"
insert into public.hermes_canonical_canary_policy_rules
  (policy_id,owner_open_id,batch_code,requested_mode,enabled)
values
  ($(Quote-Sql $policy),$(Quote-Sql $owner),$(Quote-Sql $batch),'worker_read_only',true),
  ($(Quote-Sql $noAdmissionPolicy),$(Quote-Sql $owner),$(Quote-Sql $otherBatch),'worker_read_only',true),
  ($(Quote-Sql $policy),$(Quote-Sql $owner),$(Quote-Sql $otherBatch),'worker_read_only',true),
  ($(Quote-Sql $policy),$(Quote-Sql $otherOwner),$(Quote-Sql $batch),'worker_read_only',true),
  ($(Quote-Sql $multiPolicy),$(Quote-Sql $owner),$(Quote-Sql $multiBatch),'worker_read_only',true);
insert into public.hermes_jobs
  (id,source,request_text,status,result,source_event_id,source_message_id,requester_id,
   canonical_job_state,canonical_revision,requested_mode,plan_id,subtask_id)
values
  ('$jobId','hermes_canonical_orchestration','sensitive request text','running',
   pg_catalog.jsonb_build_object('sensitive','result'),$(Quote-Sql $event),$(Quote-Sql $message),$(Quote-Sql $owner),
   'running',3,'worker_read_only','plan-fixture','subtask-fixture'),
  ('$multiJobId','hermes_canonical_orchestration','other policy request','queued',
   null,'evt_multi_job','msg_multi',$(Quote-Sql $owner),
   'queued',0,'worker_read_only','plan-multi','subtask-multi');
insert into public.hermes_canonical_canary_admissions
  (admission_id,policy_id,owner_open_id,batch_code,requested_mode,event_id,request_id,job_id,consumed_at)
values
  ('$admissionId',$(Quote-Sql $policy),$(Quote-Sql $owner),$(Quote-Sql $batch),
   'worker_read_only',$(Quote-Sql $event),$(Quote-Sql $message),'$jobId',pg_catalog.now()),
  ('$multiAdmissionId',$(Quote-Sql $multiPolicy),$(Quote-Sql $owner),$(Quote-Sql $multiBatch),
   'worker_read_only',$(Quote-Sql $event),'multi-request','$multiJobId',pg_catalog.now());
insert into public.hermes_job_attempts
  (attempt_id,job_id,attempt_number,worker_id,attempt_state)
values ('attempt-fixture-1','$jobId',1,'worker-fixture','running');
insert into public.hermes_job_leases
  (lease_id,job_id,attempt_id,worker_id,lease_state,acquired_at,expires_at)
values ('lease-fixture-1','$jobId','attempt-fixture-1','worker-fixture','active',
  pg_catalog.now(),pg_catalog.now()+interval '5 minutes');
insert into public.hermes_job_terminals
  (terminal_id,job_id,attempt_id,worker_id,report_identity,worker_execution_status,
   task_goal_status,effective_final_status,terminal_at,canonical_report)
values ('$terminalId','$jobId','attempt-fixture-1','worker-fixture','report-fixture',
  'succeeded','succeeded','succeeded',pg_catalog.now(),
  pg_catalog.jsonb_build_object('secret','terminal-payload-marker'));
insert into public.hermes_job_results (job_id,output,files_changed)
values ('$jobId','sensitive output',array['secret.txt']);
"@ | Out-Null

  $valid = Invoke-Audit
  Assert-Equal $valid.policy_row_count 1 'valid_policy_count'
  Assert-Equal $valid.policy_enabled $true 'valid_policy_enabled'
  Assert-Equal $valid.scope_admission_count 1 'valid_scope_admission_count'
  Assert-Equal $valid.matching_event_admission_count 1 'valid_event_admission_count'
  Assert-Equal $valid.scope_job_count 1 'valid_scope_job_count'
  Assert-Equal $valid.event_job_count 1 'valid_event_job_count'
  Assert-Equal $valid.job_id $jobId 'valid_job_identity'
  Assert-Equal $valid.canonical_revision 3 'valid_revision'
  Assert-Equal $valid.attempt_count 1 'valid_attempt_count'
  Assert-Equal $valid.attempt_ids[0] 'attempt-fixture-1' 'valid_attempt_identity'
  Assert-Equal $valid.lease_ids[0] 'lease-fixture-1' 'valid_lease_identity'
  Assert-Equal $valid.terminal_ids[0] $terminalId 'valid_terminal_identity'
  Assert-Equal $valid.result_count 1 'valid_result_count'
  Assert-Equal $valid.result_exists $true 'valid_result_exists'
  Assert-Equal $valid.source_event_id_sha256 $eventHash 'event_hash_contract'
  Assert-Equal $valid.source_message_id_sha256 (Get-Sha256 $message) 'message_hash_contract'

  $serialized = $valid | ConvertTo-Json -Compress -Depth 6
  foreach ($raw in @($owner,$batch,$event,$message,'sensitive request text','sensitive output','terminal-payload-marker')) {
    Assert-True (-not $serialized.Contains($raw)) "raw_value_excluded_$raw"
  }
  $crossOwner = Invoke-Audit -OwnerHash (Get-Sha256 'ou_other')
  Assert-Equal $crossOwner.job_id $null 'cross_owner_denied'
  $crossBatch = Invoke-Audit -BatchHash (Get-Sha256 'BATCH-OTHER')
  Assert-Equal $crossBatch.job_id $null 'cross_batch_denied'
  $crossPolicy = Invoke-Audit -Policy 'CANARY-OTHER'
  Assert-Equal $crossPolicy.job_id $null 'cross_policy_denied'
  $crossEvent = Invoke-Audit -EventHash (Get-Sha256 'evt_other')
  Assert-Equal $crossEvent.job_id $null 'cross_event_denied'

  $differentPolicyNoAdmission = Invoke-Audit `
    -Policy $noAdmissionPolicy `
    -BatchHash (Get-Sha256 $otherBatch)
  Assert-Equal $differentPolicyNoAdmission.policy_row_count 1 'different_policy_policy_exists'
  Assert-NoEventJobLeak $differentPolicyNoAdmission 'different_policy_no_admission'

  $differentBatchNoAdmission = Invoke-Audit -BatchHash (Get-Sha256 $otherBatch)
  Assert-Equal $differentBatchNoAdmission.policy_row_count 1 'different_batch_policy_exists'
  Assert-NoEventJobLeak $differentBatchNoAdmission 'different_batch_no_admission'

  $differentOwnerNoAdmission = Invoke-Audit -OwnerHash (Get-Sha256 $otherOwner)
  Assert-Equal $differentOwnerNoAdmission.policy_row_count 1 'different_owner_policy_exists'
  Assert-NoEventJobLeak $differentOwnerNoAdmission 'different_owner_no_admission'

  $differentEventNoAdmission = Invoke-Audit -EventHash (Get-Sha256 'evt_fixture_missing')
  Assert-NoEventJobLeak $differentEventNoAdmission 'same_scope_different_event' 1 1

  $multiPolicyState = Invoke-Audit `
    -Policy $multiPolicy `
    -BatchHash (Get-Sha256 $multiBatch)
  Assert-Equal $multiPolicyState.scope_admission_count 1 'multi_policy_scope_admission_count'
  Assert-Equal $multiPolicyState.matching_event_admission_count 1 'multi_policy_event_admission_count'
  Assert-Equal $multiPolicyState.event_job_count 1 'multi_policy_event_job_count'
  Assert-Equal $multiPolicyState.job_id $multiJobId 'multi_policy_exact_job'
  Assert-Equal $valid.job_id $jobId 'original_policy_exact_job_after_multi_policy'
  Assert-True (-not (($multiPolicyState | ConvertTo-Json -Compress).Contains($jobId))) 'multi_policy_does_not_expose_original_job'
  Assert-True (-not (($valid | ConvertTo-Json -Compress).Contains($multiJobId))) 'original_policy_does_not_expose_multi_job'

  Invoke-Psql @"
alter table public.hermes_canonical_canary_admissions
  drop constraint hermes_canonical_canary_one_scope_once;
alter table public.hermes_canonical_canary_admissions
  drop constraint hermes_canonical_canary_same_event_idempotent;
insert into public.hermes_canonical_canary_admissions
  (policy_id,owner_open_id,batch_code,requested_mode,event_id,request_id,job_id,consumed_at)
values ($(Quote-Sql $policy),$(Quote-Sql $owner),$(Quote-Sql $batch),'worker_read_only',
  $(Quote-Sql $event),'duplicate-message','$jobId',pg_catalog.now());
"@ | Out-Null
  $duplicateAdmission = Invoke-Audit
  Assert-Equal $duplicateAdmission.scope_admission_count 2 'duplicate_admission_count'
  Assert-Equal $duplicateAdmission.duplicate_admission_detected $true 'duplicate_admission_detected'
  Assert-Equal $duplicateAdmission.event_job_count 1 'duplicate_same_job_distinct_count'
  Assert-Equal $duplicateAdmission.duplicate_job_detected $false 'duplicate_admission_same_job_not_duplicate_job'

  Invoke-Psql @"
insert into public.hermes_jobs
  (id,source,request_text,status,source_event_id,source_message_id,requester_id,
   canonical_job_state,canonical_revision,requested_mode,plan_id,subtask_id)
values ('44444444-4444-4444-8444-444444444444','hermes_canonical_orchestration',
  'second sensitive request','queued','evt_duplicate_linked_job','second-message',$(Quote-Sql $owner),
  'queued',0,'worker_read_only','plan-duplicate','subtask-duplicate');
insert into public.hermes_canonical_canary_admissions
  (policy_id,owner_open_id,batch_code,requested_mode,event_id,request_id,job_id,consumed_at)
values ($(Quote-Sql $policy),$(Quote-Sql $owner),$(Quote-Sql $batch),'worker_read_only',
  $(Quote-Sql $event),'duplicate-job-message','44444444-4444-4444-8444-444444444444',pg_catalog.now());
"@ | Out-Null
  $duplicateJob = Invoke-Audit
  Assert-Equal $duplicateJob.event_job_count 2 'duplicate_job_count'
  Assert-Equal $duplicateJob.duplicate_job_detected $true 'duplicate_job_detected'

  $functionBody = Invoke-Psql "select p.prosrc from pg_catalog.pg_proc p where p.oid='public.audit_canonical_canary_scope_state(text,text,text,text,text)'::regprocedure"
  Assert-True (-not ($functionBody -match '(?i)\b(insert|update|delete|merge|truncate|alter|drop|create|grant|copy|notify|execute)\b')) 'function_body_mutation_free'
  Assert-True (-not ($functionBody -match '(?i)\bexecute\b')) 'function_body_dynamic_sql_false'

  Assert-Equal (Invoke-Psql @'
select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
from pg_catalog.pg_roles where rolname='production_schema_audit_reader'
'@) 't|f|f|f|f|f|f' 'reader_role_attributes_unchanged'
  Assert-Equal (Invoke-Psql @'
select pg_catalog.bool_and(c.relrowsecurity) and not pg_catalog.bool_or(c.relforcerowsecurity)
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (
  'hermes_canonical_canary_policy_rules','hermes_canonical_canary_admissions',
  'hermes_jobs','hermes_job_attempts','hermes_job_leases','hermes_job_terminals','hermes_job_results')
'@) 't' 'rls_contract_unchanged'

  Set-Phase 'SCHEMA_DRIFT_ASSERTIONS'

  Initialize-FixtureDatabase 'drift_missing_table'
  Invoke-Psql 'drop table public.hermes_job_results' 'postgres' 'drift_missing_table' | Out-Null
  Assert-Migration-Aborts 'drift_missing_table' 'missing_table'

  Initialize-FixtureDatabase 'drift_missing_column'
  Invoke-Psql 'alter table public.hermes_jobs drop column source_message_id' 'postgres' 'drift_missing_column' | Out-Null
  Assert-Migration-Aborts 'drift_missing_column' 'missing_column'

  Initialize-FixtureDatabase 'drift_wrong_type'
  Invoke-Psql 'alter table public.hermes_job_results alter column job_id type text using job_id::text' 'postgres' 'drift_wrong_type' | Out-Null
  Assert-Migration-Aborts 'drift_wrong_type' 'wrong_column_type'

  Initialize-FixtureDatabase 'drift_wrong_nullability'
  Invoke-Psql 'alter table public.hermes_jobs alter column updated_at drop not null' 'postgres' 'drift_wrong_nullability' | Out-Null
  Assert-Migration-Aborts 'drift_wrong_nullability' 'wrong_nullability'

  Initialize-FixtureDatabase 'drift_wrong_relkind'
  Invoke-Psql @'
drop table public.hermes_job_results;
create view public.hermes_job_results as select null::uuid as job_id where false;
'@ 'postgres' 'drift_wrong_relkind' | Out-Null
  Assert-Migration-Aborts 'drift_wrong_relkind' 'wrong_relation_kind'

  Initialize-FixtureDatabase 'drift_digest_missing' $false
  Assert-Migration-Aborts 'drift_digest_missing' 'digest_dependency_missing'

  Initialize-FixtureDatabase 'drift_target_conflict'
  Invoke-Psql @'
create function public.audit_canonical_canary_scope_state(text,text,text,text,text)
returns integer language sql as 'select 7';
'@ 'postgres' 'drift_target_conflict' | Out-Null
  Assert-Migration-Aborts 'drift_target_conflict' 'target_function_conflict' $false
  Assert-Equal (Invoke-Psql @'
select pg_catalog.btrim(p.prosrc) from pg_catalog.pg_proc p
where p.oid='public.audit_canonical_canary_scope_state(text,text,text,text,text)'::regprocedure
'@ 'postgres' 'drift_target_conflict') 'select 7' 'target_function_not_replaced'

  $summary = @(
    'POSTGRES_VERSION=18',
    "REAL_POSTGRES_CHECKS=$checks",
    'REAL_POSTGRES_FAILURES=0',
    'LOCAL_MIGRATION_TESTS_PASSED=true'
  )
  $summary | Write-Output
  if ($ResultPath) { $summary | Set-Content -LiteralPath $ResultPath -Encoding ascii }
}
catch {
  $failure = @(
    'LOCAL_MIGRATION_TESTS_PASSED=false',
    ('FAILURE=' + $_.Exception.Message)
  )
  if ($ResultPath) { $failure | Set-Content -LiteralPath $ResultPath -Encoding ascii }
  throw
}
finally {
  if ($postgresProcess -and -not $postgresProcess.HasExited) {
    Stop-Process -Id $postgresProcess.Id -Force
    $postgresProcess.WaitForExit(5000) | Out-Null
  }
  if (Test-Path -LiteralPath $dataDir) {
    $resolved = (Resolve-Path -LiteralPath $dataDir).Path
    $resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
    if (-not $resolved.StartsWith($resolvedFixtureRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside fixture root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  if (Test-Path -LiteralPath $fixtureRoot) {
    $remaining = @(Get-ChildItem -LiteralPath $fixtureRoot -Force)
    if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $fixtureRoot -Force }
  }
}
