type WorkerSyncStatus = "queued" | "running" | "succeeded" | "failed";

export interface WorkerFeishuSyncInput {
  recordId?: string | null;
  status: WorkerSyncStatus;
  stage?: string | null;
  progressPercent?: number | null;
  currentStep?: string | null;
  statusMessage?: string | null;
  gitCommitSha?: string | null;
  errorText?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
}

interface FeishuField {
  field_name: string;
  type: number;
}

interface FeishuApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

const NUMBER_FIELD = 2;
const DATE_FIELD = 5;

let cachedToken: { token: string; expiresAt: number } | null = null;

function getEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parseBitableAppToken(raw: string): string {
  const match = raw.match(/\/base\/([A-Za-z0-9]+)/);
  return match ? match[1] : raw.trim();
}

function parseBitableTableId(raw: string): string {
  const tableMatch = raw.match(/[?&]table=([A-Za-z0-9]+)/);
  if (tableMatch) return tableMatch[1];
  const pathMatch = raw.match(/\/tbl([A-Za-z0-9]+)/);
  return pathMatch ? `tbl${pathMatch[1]}` : raw.trim();
}

function sanitizeFeishuError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/tenant_access_token["':\s]+[^"',\s}]+/gi, "tenant_access_token:[redacted]")
    .replace(/app_secret["':\s]+[^"',\s}]+/gi, "app_secret:[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(open-apis\/bitable\/v1\/apps\/)[A-Za-z0-9]+/g, "$1[app_token]");
}

async function getFeishuAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;

  const appId = getEnv("FEISHU_APP_ID");
  const appSecret = getEnv("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET env");
  }

  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: new TextEncoder().encode(JSON.stringify({ app_id: appId, app_secret: appSecret })),
  });
  const data = (await res.json()) as FeishuApiResponse<{ tenant_access_token?: string; expire?: number }> & {
    tenant_access_token?: string;
    expire?: number;
  };
  const token = data.tenant_access_token ?? data.data?.tenant_access_token;
  if (data.code !== 0 || !token) {
    throw new Error(`feishu token failed: code=${data.code} msg=${data.msg}`);
  }

  cachedToken = {
    token,
    expiresAt: now + Math.max(60_000, (data.expire ?? data.data?.expire ?? 7200) * 1000 - 60_000),
  };
  return cachedToken.token;
}

function getBitableConfig(): { appToken: string; tableId: string } | null {
  const rawAppToken = getEnv("BITABLE_APP_TOKEN") ?? getEnv("FEISHU_BITABLE_APP_TOKEN");
  const rawTableId =
    getEnv("BITABLE_WORKER_TABLE_ID") ??
    getEnv("BITABLE_TASK_TABLE_ID") ??
    getEnv("BITABLE_TABLE_ID") ??
    getEnv("FEISHU_BITABLE_TABLE_ID");

  if (!rawAppToken || !rawTableId) return null;
  return {
    appToken: parseBitableAppToken(rawAppToken),
    tableId: parseBitableTableId(rawTableId),
  };
}

async function listFields(accessToken: string, appToken: string, tableId: string): Promise<FeishuField[]> {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const raw = await res.text();
  let data: FeishuApiResponse<{ items?: FeishuField[] }>;
  try {
    data = JSON.parse(raw) as FeishuApiResponse<{ items?: FeishuField[] }>;
  } catch {
    throw new Error(`feishu fields non-json: ${raw.slice(0, 120)}`);
  }
  if (data.code !== 0) {
    throw new Error(`feishu fields failed: code=${data.code} msg=${data.msg}`);
  }
  return data.data?.items ?? [];
}

function firstExistingField(
  fields: FeishuField[],
  names: string[]
): FeishuField | null {
  for (const name of names) {
    const field = fields.find((item) => item.field_name === name);
    if (field) return field;
  }
  console.log(`[feishu-worker-sync] skip missing field: ${names.join(" / ")}`);
  return null;
}

function asFeishuDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function putField(
  output: Record<string, unknown>,
  field: FeishuField | null,
  value: unknown
) {
  if (!field || value === undefined) return;
  if (field.type === DATE_FIELD) {
    const dateValue = typeof value === "string" ? asFeishuDate(value) : null;
    if (dateValue !== null) output[field.field_name] = dateValue;
    return;
  }
  if (field.type === NUMBER_FIELD && typeof value === "string") {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) output[field.field_name] = numericValue;
    return;
  }
  output[field.field_name] = value;
}

function statusForBitable(status: WorkerSyncStatus): string {
  return status;
}

function stageForBitable(input: WorkerFeishuSyncInput): string {
  if (input.stage) return input.stage;
  if (input.status === "queued" || input.status === "running") return "execution";
  if (input.status === "failed") return "failed";
  return "completed";
}

function buildFields(realFields: FeishuField[], input: WorkerFeishuSyncInput): Record<string, unknown> {
  const now = input.updatedAt ?? new Date().toISOString();
  const fields: Record<string, unknown> = {};

  putField(fields, firstExistingField(realFields, ["任务状态", "status", "Status"]), statusForBitable(input.status));
  putField(fields, firstExistingField(realFields, ["当前阶段", "stage", "phase", "Stage"]), stageForBitable(input));
  putField(fields, firstExistingField(realFields, ["进度百分比", "progress_percent", "Progress", "进度"]), input.progressPercent);
  putField(fields, firstExistingField(realFields, ["当前步骤", "current_step", "Current Step", "步骤"]), input.currentStep);
  putField(fields, firstExistingField(realFields, ["状态消息", "status_message", "Status Message", "消息"]), input.statusMessage);
  putField(fields, firstExistingField(realFields, ["Git Commit", "git_commit_sha", "GitCommit", "commit"]), input.gitCommitSha);
  putField(fields, firstExistingField(realFields, ["错误原因", "error_text", "Error", "失败原因"]), input.errorText ?? "");
  putField(fields, firstExistingField(realFields, ["完成时间", "completed_at", "Completed At"]), input.completedAt);
  putField(fields, firstExistingField(realFields, ["更新时间", "updated_at", "Updated At"]), now);

  return fields;
}

export async function syncWorkerStatusToFeishu(input: WorkerFeishuSyncInput): Promise<void> {
  if (!input.recordId) {
    console.log("[feishu-worker-sync] skip: missing bitable record id");
    return;
  }

  const config = getBitableConfig();
  if (!config) {
    console.log("[feishu-worker-sync] skip: missing bitable app/table env");
    return;
  }

  try {
    const accessToken = await getFeishuAccessToken();
    const realFields = await listFields(accessToken, config.appToken, config.tableId);
    const fields = buildFields(realFields, input);
    if (Object.keys(fields).length === 0) {
      console.log("[feishu-worker-sync] skip: no compatible bitable fields");
      return;
    }

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${input.recordId}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: new TextEncoder().encode(JSON.stringify({ fields })),
    });
    const raw = await res.text();
    let data: FeishuApiResponse;
    try {
      data = JSON.parse(raw) as FeishuApiResponse;
    } catch {
      throw new Error(`feishu update non-json: ${raw.slice(0, 120)}`);
    }
    if (data.code !== 0) {
      throw new Error(`feishu update failed: code=${data.code} msg=${data.msg}`);
    }
  } catch (error) {
    console.error("[feishu-worker-sync] non-blocking sync failed:", sanitizeFeishuError(error));
  }
}
