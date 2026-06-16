/**
 * 飞书 Bitable 8 张表一键创建路由
 * POST /api/feishu/create-tables
 * 鉴权: FEISHU_API_TOKEN
 *
 * 在 Bitable 所在租户的飞书 app 配 bitable:app 权限后,
 * 本路由会用 Vercel env 里的 FEISHU_APP_SECRET 调飞书 API,
 * 自动建 8 张表 (需求池/任务看板/老板决策中心/设计稿与页面/Bug与风险/上线记录/日报周报/Agent配置表).
 *
 * 注意: 关联记录 (type=18) 需要另一张表已存在, 首次跑用文本 ID 字段,
 *       之后再 patch 成 link 字段.
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const T_TEXT = 1;
const T_SELECT = 3;
const T_DATE = 5;
const T_CHECKBOX = 7;
const T_URL = 15;
const T_AUTO_NUM = 1001;
const T_CREATED = 21;
const T_MODIFIED = 22;

function getEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function parseBitableAppToken(raw: string): string {
  const m = raw.trim().match(/\/base\/([A-Za-z0-9]+)/);
  return m ? m[1] : raw.trim();
}

async function getToken(): Promise<string> {
  const appId = getEnv("FEISHU_APP_ID");
  const appSecret = getEnv("FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("missing FEISHU_APP_ID/SECRET env");
  const bytes = new TextEncoder().encode(JSON.stringify({ app_id: appId, app_secret: appSecret }));
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: bytes,
  });
  const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`feishu token failed: code=${data.code} msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

async function createTable(
  token: string,
  appToken: string,
  table: { table: { name: string; default_view_name: string }; fields: unknown[] }
) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`;
  const bodyStr = JSON.stringify(table);
  const bytes = new TextEncoder().encode(bodyStr);
  console.log(`[createTable] ${table.table.name} body: ${bodyStr.slice(0, 800)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: bytes,
  });
  const raw = await res.text();
  console.log(`[createTable] ${table.table.name} status=${res.status} body: ${raw.slice(0, 500)}`);
  let data: { code: number; msg: string; data?: { table_id: string; fields: { field_name: string; type: number }[] } };
  try { data = JSON.parse(raw); }
  catch { throw new Error(`non-json: ${raw.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(`create table ${table.table.name} failed: code=${data.code} msg=${data.msg}`);
  return data.data!;
}

function fText(name: string) { return { field_name: name, type: T_TEXT }; }
function fSelect(name: string, options: string[]) {
  return { field_name: name, type: T_SELECT, property: { options: options.map((o) => ({ name: o })) } };
}
function fCheckbox(name: string) { return { field_name: name, type: T_CHECKBOX }; }
function fUrl(name: string) { return { field_name: name, type: T_URL }; }
function fAutoNum(name: string) { return { field_name: name, type: T_AUTO_NUM }; }
function fDate(name: string, withTime = false) {
  return { field_name: name, type: T_DATE, property: { date_formatter: "yyyy-MM-dd" + (withTime ? " HH:mm" : "") } };
}
function fCreated(name = "创建时间") { return { field_name: name, type: T_CREATED }; }
function fModified(name = "更新时间") { return { field_name: name, type: T_MODIFIED }; }

const TABLES: { name: string; build: () => { table: { name: string; default_view_name: string }; fields: unknown[] } }[] = [
  {
    name: "需求池",
    build: () => ({
      table: { name: "需求池", default_view_name: "全部需求" },
      fields: [
        fAutoNum("需求 ID"),
        fText("需求名称"),
        fText("需求描述"),
        fSelect("需求来源", ["老板", "Hermes", "用户反馈", "Codex", "其他"]),
        fSelect("优先级", ["P0", "P1", "P2"]),
        fSelect("类型", ["产品", "设计", "开发", "运营"]),
        fSelect("状态", ["待分析", "待确认", "已拆解", "开发中", "待验收", "已上线", "暂缓"]),
        fCheckbox("是否需要老板确认"),
        fText("Hermes 建议"),
        fText("验收标准"),
        fText("关联任务 ID"),
        fUrl("预览链接"),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "任务看板",
    build: () => ({
      table: { name: "任务看板", default_view_name: "全部任务" },
      fields: [
        fAutoNum("任务 ID"),
        fText("关联需求 ID"),
        fText("任务名称"),
        fText("任务说明"),
        fSelect("执行角色", ["产品Agent", "设计Agent", "Codex", "测试Agent", "Hermes", "老板"]),
        fSelect("状态", ["待执行", "执行中", "待 Review", "待验收", "已完成", "失败"]),
        fSelect("优先级", ["P0", "P1", "P2"]),
        fText("输入材料"),
        fText("输出要求"),
        fUrl("GitHub Issue"),
        fUrl("GitHub PR"),
        fUrl("Vercel Preview"),
        fText("失败原因"),
        fText("下次动作"),
        fDate("截止时间"),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "老板决策中心",
    build: () => ({
      table: { name: "老板决策中心", default_view_name: "待确认" },
      fields: [
        fAutoNum("决策 ID"),
        fText("问题"),
        fText("背景"),
        fText("选项 A"),
        fText("选项 B"),
        fText("选项 C"),
        fText("Hermes 建议"),
        fSelect("推荐选项", ["A", "B", "C"]),
        fSelect("老板选择", ["A", "B", "C", "暂缓", "未回复"]),
        fSelect("状态", ["待老板确认", "已确认", "已执行", "已暂缓"]),
        fText("关联需求 ID"),
        fText("关联任务 ID"),
        fSelect("通知状态", ["未通知", "已通知", "已回复", "已忽略"]),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "设计稿与页面",
    build: () => ({
      table: { name: "设计稿与页面", default_view_name: "全部页面" },
      fields: [
        fAutoNum("页面 ID"),
        fText("页面名称"),
        fSelect("页面类型", ["首页", "列表页", "详情页", "发布页", "后台", "登录", "其他"]),
        fSelect("页面状态", ["待设计", "设计中", "待开发", "开发中", "待验收", "已上线", "暂缓"]),
        fText("页面目标"),
        fText("页面结构"),
        fSelect("设计风格", ["年轻", "社交", "简洁", "高级", "其他"]),
        fUrl("Figma 链接"),
        fUrl("Vercel 链接"),
        fText("验收意见"),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "Bug 与风险",
    build: () => ({
      table: { name: "Bug 与风险", default_view_name: "全部 Bug" },
      fields: [
        fAutoNum("Bug ID"),
        fText("问题标题"),
        fText("问题描述"),
        fSelect("严重程度", ["致命", "高", "中", "低"]),
        fText("影响页面 ID"),
        fSelect("负责人", ["Codex", "Hermes", "老板", "其他"]),
        fSelect("状态", ["待修复", "修复中", "待复测", "已修复", "暂不处理"]),
        fText("复现步骤"),
        fUrl("修复 PR"),
        fText("复测结果"),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "上线记录",
    build: () => ({
      table: { name: "上线记录", default_view_name: "全部上线" },
      fields: [
        fText("版本号"),
        fText("上线内容"),
        fSelect("环境", ["Preview", "Staging", "Production"]),
        fUrl("GitHub PR"),
        fUrl("Vercel 链接"),
        fCheckbox("是否老板确认"),
        fSelect("上线状态", ["待上线", "已上线", "回滚", "失败", "暂缓"]),
        fText("回滚版本"),
        fDate("上线时间", true),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "日报周报",
    build: () => ({
      table: { name: "日报周报", default_view_name: "按日期降序" },
      fields: [
        fDate("日期"),
        fText("今日完成"),
        fText("当前阻塞"),
        fText("需要老板确认"),
        fText("明日计划"),
        fSelect("风险等级", ["低", "中", "高"]),
        fSelect("发送状态", ["未发送", "已发送", "已失败"]),
        fCreated(),
        fModified(),
      ],
    }),
  },
  {
    name: "Agent 配置表",
    build: () => ({
      table: { name: "Agent 配置表", default_view_name: "全部 Agent" },
      fields: [
        fText("Agent 名称"),
        fSelect("角色", ["总管", "开发", "测试", "设计", "运营", "其他"]),
        fText("允许动作"),
        fText("禁止动作"),
        fSelect("调用方式", ["Webhook", "GitHub", "手动", "本地"]),
        fUrl("API 地址"),
        fSelect("状态", ["启用", "暂停", "已废弃"]),
        fCreated(),
        fModified(),
      ],
    }),
  },
];

export async function POST(req: NextRequest) {
  try {
    const expected = getEnv("FEISHU_API_TOKEN");
    if (expected) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${expected}`) {
        return NextResponse.json({ code: 401, message: "unauthorized" }, { status: 401 });
      }
    }

    const rawAppToken = getEnv("BITABLE_APP_TOKEN");
    if (!rawAppToken) return NextResponse.json({ code: 500, message: "BITABLE_APP_TOKEN missing" }, { status: 500 });
    const appToken = parseBitableAppToken(rawAppToken);

    const token = await getToken();
    const created: { name: string; table_id: string; fields: { field_name: string; type: number }[] }[] = [];

    for (const { name, build } of TABLES) {
      const spec = build();
      const data = await createTable(token, appToken, spec);
      created.push({ name, table_id: data.table_id, fields: data.fields });
    }

    return NextResponse.json({ code: 0, message: "8 tables created", data: { app_token: appToken, tables: created } });
  } catch (e) {
    return NextResponse.json({ code: 500, message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "POST to create 8 tables, requires FEISHU_API_TOKEN auth" });
}
