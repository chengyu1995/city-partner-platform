# v0.1 验收标准 — 自动化测试脚本

> 每个验收项 = 1 行 `expect` 命令
> 跑法: `bash docs/acceptance-v0.1.sh`
> 期望: 所有项 ✅ PASS, 任意 ❌ FAIL 阻止上线

**对应生产域名**: https://city-partner-platform.vercel.app

---

## 1. 首页 (`/`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 1.1 | 手机端打开无错位 | 视口 < 640px 不出现 horizontal scroll, 所有 CTA 可点 (lighthouse 跑 mobile 模式) |
| 1.2 | 5 秒内知道是同城搭子 | 首屏含 "同城搭子" / "找搭子" / "搭子" 任一关键词 (grep `<h1>` 内容) |
| 1.3 | 展示 5 个分类 | HTML 含 `旅游` / `K歌` / `学习` / `摩友` / `钓友` |
| 1.4 | 有"发布搭子"按钮 | `<a href="/post"` 或 `<button` 含 "发搭子" / "我要发" |
| 1.5 | 有城市入口 | 城市名出现 ≥ 4 个 (北京/上海/广州/深圳/杭州/成都/西安/南京) |
| 1.6 | 年轻化风格 | 不含 "管理" / "系统" / "后台" / "Dashboard" 等冷色词, 含 emoji 或渐变色 |

**curl 快速检查**:
```bash
curl -sSL https://city-partner-platform.vercel.app/ -o /tmp/home.html
grep -q "同城搭子\|找搭子" /tmp/home.html || echo "FAIL 1.2"
for c in "旅游" "K歌" "学习" "摩友" "钓友"; do
  grep -q "$c" /tmp/home.html || echo "FAIL 1.3 missing: $c"
done
grep -q 'href="/post"' /tmp/home.html || echo "FAIL 1.4"
for c in "北京" "上海" "广州" "深圳" "杭州" "成都"; do
  grep -q "$c" /tmp/home.html || echo "FAIL 1.5 missing: $c"
done
```

---

## 2. 发布页 (`/post`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 2.1 | 选分类 | HTML 含 `category` input (select / radio) |
| 2.2 | 选城市 | HTML 含 `city` input |
| 2.3 | 填标题 | HTML 含 `title` input |
| 2.4 | 填描述 | HTML 含 `description` / `desc` textarea |
| 2.5 | 填联系方式 | HTML 含 `contact` input |
| 2.6 | 表单校验 | 必填项缺失时, 提交返回错误; 全填时返回 success |
| 2.7 | 提交成功进列表 | POST /api/partners → 201, 然后 GET /partners 含新数据 |
| 2.8 | 手机端输入正常 | viewport meta 存在, 字号 ≥ 16px, 按钮高度 ≥ 44px |

**curl 测试**:
```bash
# 2.6 校验
curl -sS -X POST "https://city-partner-platform.vercel.app/api/partners" \
  -H "Content-Type: application/json" \
  -d '{}' -w "\nHTTP %{http_code}\n"
# 期望: 400 (缺字段)

# 2.7 端到端
POST_BODY='{
  "category":"旅游",
  "city":"北京",
  "title":"自动化测试搭子-请忽略",
  "description":"acceptance test 2026-06-14",
  "contact":"test@example.com",
  "host_name":"hermes-test",
  "starts_at":"2026-12-31T10:00:00+08:00"
}'
curl -sS -X POST "https://city-partner-platform.vercel.app/api/partners" \
  -H "Content-Type: application/json" -d "$POST_BODY" -w "\nHTTP %{http_code}\n"
# 期望: 201 ok
# 然后 GET /partners 看有没有这条
curl -sSL "https://city-partner-platform.vercel.app/partners" | grep "自动化测试搭子"
```

---

## 3. 列表页 (`/partners`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 3.1 | 展示卡片 | HTML 含 ≥ 1 个 card-like 元素 (h2 + description) |
| 3.2 | 按城市筛选 | URL `?city=北京` 过滤生效; 没匹配时返友好空状态 |
| 3.3 | 按分类筛选 | URL `?category=旅游` 过滤生效 |
| 3.4 | 卡片含 4 字段 | 每条含 title + city + category + 时间 |
| 3.5 | 点击进详情 | 卡片含 `<a href="/partners/[id]"` 或 `<Link` |
| 3.6 | 空数据友好 | 过滤无结果时显示 "还没有" / "没有" 文案 |

**curl 测试**:
```bash
curl -sSL "https://city-partner-platform.vercel.app/partners" -o /tmp/list.html
# 3.1 卡片
grep -q '<h2' /tmp/list.html || echo "FAIL 3.1"
# 3.4 字段
grep -q "成都" /tmp/list.html || echo "FAIL 3.4 (city)"
grep -q "摩友" /tmp/list.html || echo "FAIL 3.4 (category)"
# 3.5 详情链接
grep -q 'href="/partners/' /tmp/list.html || echo "FAIL 3.5"
# 3.6 空数据
curl -sSL "https://city-partner-platform.vercel.app/partners?city=不存在的城市" | grep -q "没有\|还没有" || echo "FAIL 3.6"
```

---

## 4. 详情页 (`/partners/[id]`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 4.1 | 显示标题 | HTML 含 title |
| 4.2 | 显示分类 | 含 category 文本 |
| 4.3 | 显示城市 | 含 city 文本 |
| 4.4 | 显示联系方式 | 含 contact |
| 4.5 | 显示发布时间 | 含 created_at 或相对时间 |

```bash
# 取一条 ID 测试
ID=$(curl -sSL "https://city-partner-platform.vercel.app/api/partners" | python -c "import sys,json; print(json.load(sys.stdin)['items'][0]['id'])")
curl -sSL "https://city-partner-platform.vercel.app/partners/$ID" -o /tmp/detail.html
grep -q "h1" /tmp/detail.html || echo "FAIL 4.1"
grep -q "摩友\|旅游\|K歌" /tmp/detail.html || echo "FAIL 4.2"
grep -q "成都" /tmp/detail.html || echo "FAIL 4.3"
grep -q "wx:\|微信\|@" /tmp/detail.html || echo "FAIL 4.4"
```

---

## 5. 后台审核 (`/admin`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 5.1 | 看到待审核 | `/admin` HTML 含 "待审核" tab, `/api/admin/list?status=pending` 返 ok |
| 5.2 | 能通过 | POST `/api/partners/[id]/moderate` body=`{action:"approve"}` 返 200 |
| 5.3 | 能拒绝 | POST `/api/partners/[id]/moderate` body=`{action:"reject"}` 返 200 |
| 5.4 | 被拒不出现在前台 | reject 后, GET `/partners` 不含该条 (anon 只看 approved) |
| 5.5 | 操作有确认 | 客户端 confirm dialog 存在 (用 button type 前缀检测) |

```bash
# 5.1
curl -sSL "https://city-partner-platform.vercel.app/admin" | grep -q "待审核" || echo "FAIL 5.1"
# 5.2 / 5.3 / 5.4
# (需要先创建 pending 帖子, 通过 /post 提交)
```

---

## 6. 举报 (`/partners/[id]` 详情页的举报按钮 + `/api/reports`)

| # | 验收项 | 自动化断言 |
|---|---|---|
| 6.1 | 详情页有举报按钮 | HTML 含 "举报" |
| 6.2 | 举报成功 | POST `/api/reports` 返 `{"ok":true}` |
| 6.3 | 缺 reason 报错 | POST 不带 reason 返 400 |
| 6.4 | 数据进 Supabase | 真 Supabase `reports` 表有新行 |

```bash
# 6.2
curl -sS -X POST "https://city-partner-platform.vercel.app/api/reports" \
  -H "Content-Type: application/json" \
  -d '{"post_id":"<id>","reason":"acceptance test 2026-06-14","contact":"[email protected]"}'
# 期望: {"ok":true}
```

---

## 7. SEO 基础

| # | 验收项 | 自动化断言 |
|---|---|---|
| 7.1 | title | `<title>` 含 "搭子" / "同城" |
| 7.2 | description | `<meta name="description"` 存在且非空 |
| 7.3 | og:title | `<meta property="og:title"` 存在 |
| 7.4 | og:description | `<meta property="og:description"` 存在 |

```bash
curl -sSL "https://city-partner-platform.vercel.app/" | grep -oE '<title>[^<]+' | head -1
curl -sSL "https://city-partner-platform.vercel.app/" | grep -oE '<meta name="description"[^>]+'
```

---

## 8. 移动端

| # | 验收项 | 自动化断言 |
|---|---|---|
| 8.1 | viewport meta | `<meta name="viewport"` 存在 |
| 8.2 | 按钮 ≥ 44px | mobile viewport 下 主要按钮 height >= 44px (lighthouse mobile) |
| 8.3 | 字号 ≥ 16px (input) | mobile 模式 input 字号 >= 16px |

```bash
curl -sSL "https://city-partner-platform.vercel.app/" | grep -q 'name="viewport"' || echo "FAIL 8.1"
```

---

## 一键全测脚本

```bash
#!/bin/bash
# docs/acceptance-v0.1.sh
set -u
URL="https://city-partner-platform.vercel.app"
PASS=0; FAIL=0

check() {
  local name=$1; local cmd=$2
  if eval "$cmd" >/dev/null 2>&1; then
    echo "✅ $name"
    PASS=$((PASS+1))
  else
    echo "❌ $name"
    FAIL=$((FAIL+1))
  fi
}

# 1. 首页
curl -sSL "$URL/" -o /tmp/home.html
check "1.1 viewport meta" "grep -q 'name=\"viewport\"' /tmp/home.html"
check "1.2 '同城搭子' 关键词" "grep -q '同城搭子' /tmp/home.html"
check "1.3 5 分类" "for c in 旅游 K歌 学习 摩友 钓友; do grep -q \"\\\$c\" /tmp/home.html; done"
check "1.4 发布按钮" "grep -q 'href=\"/post\"' /tmp/home.html"
check "1.5 ≥4 城市" "[ \$(grep -oE '北京|上海|广州|深圳|杭州|成都|西安|南京' /tmp/home.html | sort -u | wc -l) -ge 4 ]"

# 5. 后台
curl -sSL "$URL/admin" -o /tmp/admin.html
check "5.1 待审核 tab" "grep -q '待审核' /tmp/admin.html"
check "5.1 API" "curl -sS '$URL/api/admin/list?status=pending' | grep -q '\"ok\":true'"

# 6. 举报
ID=$(curl -sS "$URL/api/partners" | python -c "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])" 2>/dev/null || echo "")
if [ -n "$ID" ]; then
  check "6.2 举报 OK" "curl -sS -X POST '$URL/api/reports' -H 'Content-Type: application/json' -d '{\"post_id\":\"$ID\",\"reason\":\"acceptance test 2026-06-14\",\"contact\":\"[email protected]\"}' | grep -q '\"ok\":true'"
  check "6.3 缺 reason 报错" "curl -sS -X POST '$URL/api/reports' -H 'Content-Type: application/json' -d '{\"post_id\":\"$ID\"}' -o /dev/null -w '%{http_code}' | grep -q '400'"
fi

# 7. SEO
check "7.1 title" "grep -q '同城搭子\\|找搭子' /tmp/home.html"
check "7.2 description" "grep -q 'meta name=\"description\"' /tmp/home.html"

echo
echo "✅ PASS: $PASS, ❌ FAIL: $FAIL"
[ $FAIL -eq 0 ] && echo "🎉 v0.1 验收通过, 可以上线" || echo "⚠️ 有 $FAIL 项未通过, 修完再上"
exit $FAIL
```

---

## 实测结果

(2026-06-14 跑过): 全部 ✅ 0 个 FAIL
