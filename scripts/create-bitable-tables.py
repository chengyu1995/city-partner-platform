#!/usr/bin/env python3
"""
飞书 Bitable 8 张表一键创建脚本

使用:
    1. 先在 Vercel .env 或 .env.local 配好:
       - FEISHU_APP_ID
       - FEISHU_APP_SECRET (Vercel 上的新重发值, 你自己保留)
       - BITABLE_APP_TOKEN (新企业版的 Ops1buCiWaJPqqshzdpc3A90n4b)
    2. python scripts/create-bitable-tables.py
    3. 脚本会:
       a. 拿 tenant_access_token
       b. 创建 8 张表
       c. 每张表 + 所有字段
       d. 打印 table_id 列表 (之后用得到)

注意:
    - 飞书 Bitable 单表最多 200 字段, 我们每张 8-15 字段 没问题
    - 自动编号字段类型 = 1005
    - 文本 = 1, 长文本 = 1 (飞书用同 type), 数字 = 2
    - 单选 = 3, 复选框 = 7, 关联记录 = 18
    - 日期 = 5, 日期时间 = 5 (带 time_format)
    - URL = 15, 创建时间 = 1001, 修改时间 = 1002
    - 关联记录需要先有另一张表 (按依赖顺序创建)
"""

import os
import sys
import json
import urllib.request
import urllib.error


def _load_env():
    """从 .env.local 读 (绕开 shell 渲染)"""
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    env_path = os.path.abspath(env_path)
    if os.path.exists(env_path):
        for line in open(env_path, "r", encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() and v.strip() and k.strip() not in os.environ:
                os.environ[k.strip()] = v.strip()


def get_token():
    app_id = os.environ.get("FEISHU_APP_ID", "").strip()
    app_secret = os.environ.get("FEISHU_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        sys.exit("ERROR: FEISHU_APP_ID / FEISHU_APP_SECRET 缺失")
    body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    data = json.loads(urllib.request.urlopen(req, timeout=15).read())
    if data.get("code") != 0:
        sys.exit(f"ERROR 拿 token 失败: {data}")
    return data["tenant_access_token"]


def post_table(token, app_token, table):
    """创建 1 张表 + 所有字段. 返回 {table_id, fields: [...]}"""
    url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables"
    body = json.dumps(table, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:500]}")
    if resp.get("code") != 0:
        sys.exit(f"ERROR 创表 {table.get('table', {}).get('name', '?')} 失败: {json.dumps(resp, ensure_ascii=False)}")
    return resp["data"]


# ============== 8 张表定义 ==============
# 注意: 关联记录 (type=18) 需要另一张表已创建, 所以按依赖顺序
#   1. 需求池
#   2. 任务看板 (依赖 需求池)
#   3. 老板决策中心 (依赖 需求池 + 任务看板)
#   4. 设计稿与页面 (无依赖)
#   5. Bug 与风险 (依赖 设计稿与页面)
#   6. 上线记录 (无依赖)
#   7. 日报周报 (无依赖)
#   8. Agent 配置表 (无依赖)

# 字段类型常量
T_TEXT = 1  # 文本 / 长文本
T_NUMBER = 2
T_SELECT = 3  # 单选
T_DATE = 5  # 日期 (time_format: "yyyy-MM-dd" 日期; "yyyy-MM-dd HH:mm" 日期时间)
T_CHECKBOX = 7
T_USER = 11
T_URL = 15
T_LINK = 18  # 关联记录
T_AUTO_NUM = 1005  # 自动编号
T_CREATED = 1001  # 创建时间
T_MODIFIED = 1002  # 修改时间


def field_text(name, **kw):
    """文本字段"""
    f = {"field_name": name, "type": T_TEXT}
    f.update(kw)
    return f


def field_select(name, options):
    """单选字段. options: list of str"""
    return {
        "field_name": name,
        "type": T_SELECT,
        "property": {"options": [{"name": o} for o in options]},
    }


def field_link(name, table_id):
    """关联记录. table_id 是另一张表的 ID (string)"""
    return {
        "field_name": name,
        "type": T_LINK,
        "property": {
            "table_id": table_id,
            "multiple": False,
        },
    }


def field_date(name, with_time=False):
    return {
        "field_name": name,
        "type": T_DATE,
        "property": {"date_formatter": "yyyy-MM-dd" + (" HH:mm" if with_time else "")},
    }


def field_created_time(name="创建时间"):
    return {"field_name": name, "type": T_CREATED}


def field_modified_time(name="更新时间"):
    return {"field_name": name, "type": T_MODIFIED}


def field_auto_num(name, **kw):
    f = {"field_name": name, "type": T_AUTO_NUM}
    f.update(kw)
    return f


def field_checkbox(name):
    return {"field_name": name, "type": T_CHECKBOX}


def field_url(name):
    return {"field_name": name, "type": T_URL}


# ============== 建表 ==============
def build_table_requirements():
    """表 1: 需求池"""
    return {
        "table": {"name": "需求池", "default_view_name": "全部需求"},
        "fields": [
            field_auto_num("需求 ID"),
            field_text("需求名称"),
            field_text("需求描述"),
            field_select("需求来源", ["老板", "Hermes", "用户反馈", "Codex", "其他"]),
            field_select("优先级", ["P0", "P1", "P2"]),
            field_select("类型", ["产品", "设计", "开发", "运营"]),
            field_select("状态", ["待分析", "待确认", "已拆解", "开发中", "待验收", "已上线", "暂缓"]),
            field_checkbox("是否需要老板确认"),
            field_text("Hermes 建议"),
            field_text("验收标准"),
            # 关联记录 - 任务看板 (待 任务看板 建好后再 patch 字段)
            field_text("关联任务 ID"),  # 暂用 text, 后面再改 link
            field_url("预览链接"),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_tasks():
    """表 2: 任务看板"""
    return {
        "table": {"name": "任务看板", "default_view_name": "全部任务"},
        "fields": [
            field_auto_num("任务 ID"),
            field_text("关联需求 ID"),  # 暂用 text
            field_text("任务名称"),
            field_text("任务说明"),
            field_select("执行角色", ["产品Agent", "设计Agent", "Codex", "测试Agent", "Hermes", "老板"]),
            field_select("状态", ["待执行", "执行中", "待 Review", "待验收", "已完成", "失败"]),
            field_select("优先级", ["P0", "P1", "P2"]),
            field_text("输入材料"),
            field_text("输出要求"),
            field_url("GitHub Issue"),
            field_url("GitHub PR"),
            field_url("Vercel Preview"),
            field_text("失败原因"),
            field_text("下次动作"),
            field_date("截止时间"),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_decisions():
    """表 3: 老板决策中心"""
    return {
        "table": {"name": "老板决策中心", "default_view_name": "待确认"},
        "fields": [
            field_auto_num("决策 ID"),
            field_text("问题"),
            field_text("背景"),
            field_text("选项 A"),
            field_text("选项 B"),
            field_text("选项 C"),
            field_text("Hermes 建议"),
            field_select("推荐选项", ["A", "B", "C"]),
            field_select("老板选择", ["A", "B", "C", "暂缓", "未回复"]),
            field_select("状态", ["待老板确认", "已确认", "已执行", "已暂缓"]),
            field_text("关联需求 ID"),
            field_text("关联任务 ID"),
            field_select("通知状态", ["未通知", "已通知", "已回复", "已忽略"]),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_designs():
    """表 4: 设计稿与页面"""
    return {
        "table": {"name": "设计稿与页面", "default_view_name": "全部页面"},
        "fields": [
            field_auto_num("页面 ID"),
            field_text("页面名称"),
            field_select("页面类型", ["首页", "列表页", "详情页", "发布页", "后台", "登录", "其他"]),
            field_select("页面状态", ["待设计", "设计中", "待开发", "开发中", "待验收", "已上线", "暂缓"]),
            field_text("页面目标"),
            field_text("页面结构"),
            field_select("设计风格", ["年轻", "社交", "简洁", "高级", "其他"]),
            field_url("Figma 链接"),
            field_url("Vercel 链接"),
            field_text("验收意见"),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_bugs():
    """表 5: Bug 与风险"""
    return {
        "table": {"name": "Bug 与风险", "default_view_name": "全部 Bug"},
        "fields": [
            field_auto_num("Bug ID"),
            field_text("问题标题"),
            field_text("问题描述"),
            field_select("严重程度", ["致命", "高", "中", "低"]),
            field_text("影响页面 ID"),  # 关联 设计稿
            field_select("负责人", ["Codex", "Hermes", "老板", "其他"]),
            field_select("状态", ["待修复", "修复中", "待复测", "已修复", "暂不处理"]),
            field_text("复现步骤"),
            field_url("修复 PR"),
            field_text("复测结果"),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_deploys():
    """表 6: 上线记录"""
    return {
        "table": {"name": "上线记录", "default_view_name": "全部上线"},
        "fields": [
            field_text("版本号"),
            field_text("上线内容"),
            field_select("环境", ["Preview", "Staging", "Production"]),
            field_url("GitHub PR"),
            field_url("Vercel 链接"),
            field_checkbox("是否老板确认"),
            field_select("上线状态", ["待上线", "已上线", "回滚", "失败", "暂缓"]),
            field_text("回滚版本"),
            field_date("上线时间", with_time=True),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_reports():
    """表 7: 日报周报"""
    return {
        "table": {"name": "日报周报", "default_view_name": "按日期降序"},
        "fields": [
            field_date("日期"),
            field_text("今日完成"),
            field_text("当前阻塞"),
            field_text("需要老板确认"),
            field_text("明日计划"),
            field_select("风险等级", ["低", "中", "高"]),
            field_select("发送状态", ["未发送", "已发送", "已失败"]),
            field_created_time(),
            field_modified_time(),
        ],
    }


def build_table_agents():
    """表 8: Agent 配置表"""
    return {
        "table": {"name": "Agent 配置表", "default_view_name": "全部 Agent"},
        "fields": [
            field_text("Agent 名称"),
            field_select("角色", ["总管", "开发", "测试", "设计", "运营", "其他"]),
            field_text("允许动作"),
            field_text("禁止动作"),
            field_select("调用方式", ["Webhook", "GitHub", "手动", "本地"]),
            field_url("API 地址"),
            field_select("状态", ["启用", "暂停", "已废弃"]),
            field_created_time(),
            field_modified_time(),
        ],
    }


# ============== main ==============
def main():
    _load_env()
    token = get_token()
    app_token = os.environ.get("BITABLE_APP_TOKEN", "").strip()
    if not app_token:
        sys.exit("ERROR: BITABLE_APP_TOKEN 缺失")
    # 兼容 URL
    m = app_token.strip().split("/base/")
    if len(m) == 2:
        app_token = m[1].split("?")[0]
    print(f"使用 Bitable app_token: {app_token}\n")

    builders = [
        ("表 1: 需求池", build_table_requirements),
        ("表 2: 任务看板", build_table_tasks),
        ("表 3: 老板决策中心", build_table_decisions),
        ("表 4: 设计稿与页面", build_table_designs),
        ("表 5: Bug 与风险", build_table_bugs),
        ("表 6: 上线记录", build_table_deploys),
        ("表 7: 日报周报", build_table_reports),
        ("表 8: Agent 配置表", build_table_agents),
    ]

    table_ids = {}
    for name, builder in builders:
        print(f"=== 创建 {name} ===")
        spec = builder()
        data = post_table(token, app_token, spec)
        tid = data.get("table_id", "?")
        table_ids[name] = tid
        print(f"  ✅ 创建成功: table_id = {tid}")
        for f in data.get("fields", []):
            print(f"     - {f.get('field_name', '?')} (type={f.get('type', '?')})")
        print()

    print("=" * 60)
    print("全部 8 张表创建完成!")
    print("=" * 60)
    for name, tid in table_ids.items():
        print(f"  {name}: {tid}")
    print()
    print("下一步: 把这些 table_id 加到 .env.local:")
    for i, (name, tid) in enumerate(table_ids.items(), 1):
        env_name = f"BITABLE_{['REQ', 'TASK', 'DECISION', 'DESIGN', 'BUG', 'DEPLOY', 'REPORT', 'AGENT'][i-1]}_TABLE_ID"
        print(f"  {env_name}={tid}")


if __name__ == "__main__":
    main()
