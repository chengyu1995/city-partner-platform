#!/bin/bash
# v0.1 验收一键脚本
# 跑法: bash docs/acceptance-v0.1.sh
set -u
URL="https://city-partner-platform.vercel.app"
PASS=0; FAIL=0
FAILED_LIST=""

check() {
  local name=$1; local cmd=$2
  if eval "$cmd" >/dev/null 2>&1; then
    echo "✅ $name"
    PASS=$((PASS+1))
  else
    echo "❌ $name"
    FAIL=$((FAIL+1))
    FAILED_LIST="$FAILED_LIST\n  - $name"
  fi
}

echo "=== 1. 首页 / ==="
curl -sSL "$URL/" -o /tmp/acc_home.html
check "1.1 viewport meta" "grep -q 'name=\"viewport\"' /tmp/acc_home.html"
check "1.2 '同城搭子' 关键词" "grep -q '同城搭子' /tmp/acc_home.html"
check "1.3 5 分类都出现" "grep -q '旅游' /tmp/acc_home.html && grep -q 'K歌' /tmp/acc_home.html && grep -q '学习' /tmp/acc_home.html && grep -q '摩友' /tmp/acc_home.html && grep -q '钓友' /tmp/acc_home.html"
check "1.4 发布按钮 /post" "grep -q 'href=\"/post\"' /tmp/acc_home.html"
check "1.5 >=4 城市" "test \$(grep -oE '北京|上海|广州|深圳|杭州|成都|西安|南京' /tmp/acc_home.html | sort -u | wc -l) -ge 4"
check "1.6 年轻化 (无 '系统' 等冷色词)" "! grep -q '管理系统\\|Dashboard\\|后台管理' /tmp/acc_home.html"
check "7.1 title 含搭子" "grep -q '同城搭子\\|找搭子' /tmp/acc_home.html"
check "7.2 description meta" "grep -q 'meta name=\"description\"' /tmp/acc_home.html"

echo
echo "=== 2. 发布页 /post ==="
curl -sSL "$URL/post" -o /tmp/acc_post.html
check "2.1 category" "grep -qE 'category|分类|摩友|旅游' /tmp/acc_post.html"
check "2.2 city input" "grep -q '城市' /tmp/acc_post.html"
check "2.3 title input" "grep -q '标题' /tmp/acc_post.html"
check "2.4 description" "grep -q '描述' /tmp/acc_post.html"
check "2.5 contact" "grep -q '联系' /tmp/acc_post.html"

echo
echo "=== 2.6/2.7 POST 端到端 ==="
check "2.6 缺字段返 400" "test \$(curl -sS -X POST '$URL/api/partners' -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}') = '400'"
# 2.7 创建 + 验证列表
POST_BODY='{"category":"旅游","city":"北京","title":"acceptance-v0.1-test-请忽略","description":"2026-06-14 acceptance test","contact":"test@example.com","host_name":"hermes-uat","starts_at":"2026-12-31T10:00:00+08:00"}'
CREATE_RESP=$(curl -sS -X POST "$URL/api/partners" -H "Content-Type: application/json" -d "$POST_BODY" -w "\n%{http_code}" 2>/dev/null)
CREATE_CODE=$(echo "$CREATE_RESP" | tail -1)
check "2.7 POST 创建返 200/201" "echo '$CREATE_CODE' | grep -qE '200|201'"
sleep 1
check "2.7 新帖进列表" "curl -sSL '$URL/partners' | grep -qE 'acceptance-v0.1|acceptance'"

echo
echo "=== 3. 列表页 /partners ==="
curl -sSL "$URL/partners" -o /tmp/acc_list.html
check "3.1 含卡片 (h2)" "grep -q '<h2' /tmp/acc_list.html"
check "3.2 城市筛选" "test \$(curl -sSL '$URL/partners?city=不存在的城市xxx' | grep -oE '没有|还没有' | head -1 | wc -l) -ge 1"
check "3.3 分类筛选" "test \$(curl -sSL '$URL/partners?category=旅游' -o /tmp/acc_cat.html -w '%{http_code}') = '200'"
check "3.4 卡片含字段" "grep -q '成都\\|北京\\|上海' /tmp/acc_list.html && grep -q '摩友\\|旅游\\|K歌\\|学习\\|钓友' /tmp/acc_list.html"
check "3.5 详情链接" "grep -q 'href=\"/partners/' /tmp/acc_list.html"
check "3.6 空数据友好" "curl -sSL '$URL/partners?city=不存在的城市xxx' | grep -qE '没有|还没有'"

echo
echo "=== 4. 详情页 /partners/[id] ==="
ID=$(curl -sS "$URL/api/partners" 2>/dev/null | python -c "import sys,json;d=json.load(sys.stdin);print(d['items'][0]['id'] if d.get('items') else '')" 2>/dev/null || echo "")
if [ -n "$ID" ]; then
  curl -sSL "$URL/partners/$ID" -o /tmp/acc_detail.html
  check "4.1 标题 (h1 或 h2)" "grep -qE '<h1|<h2' /tmp/acc_detail.html"
  check "4.2 分类" "grep -qE '旅游|K歌|学习|摩友|钓友' /tmp/acc_detail.html"
  check "4.3 城市" "grep -qE '北京|上海|广州|深圳|杭州|成都|西安|南京' /tmp/acc_detail.html"
  check "4.4 联系方式" "grep -qE 'wx:|微信|@|qq:|QQ' /tmp/acc_detail.html"
  check "4.5 发布时间" "grep -qE '[0-9]{4}|[0-9]+ (秒|分钟|小时|天|周|月)前|ago|ago' /tmp/acc_detail.html"
else
  echo "⚠️ 跳过详情页测试 (无数据)"
fi

echo
echo "=== 5. 后台 /admin ==="
curl -sSL "$URL/admin" -o /tmp/acc_admin.html
check "5.1 待审核" "grep -qE '待审核|审核' /tmp/acc_admin.html"
check "5.1 admin list API" "curl -sS '$URL/api/admin/list?status=pending' | grep -q '\"ok\":true'"
check "5.1 admin list approved" "curl -sS '$URL/api/admin/list?status=approved' | grep -q '\"ok\":true'"

echo
echo "=== 6. 举报 /api/reports ==="
if [ -n "$ID" ]; then
  check "6.1 详情页有举报 (link 或 button)" "grep -qE '举报|Report' /tmp/acc_detail.html"
  RESP=$(curl -sS -X POST "$URL/api/reports" -H "Content-Type: application/json" -d "{\"post_id\":\"$ID\",\"reason\":\"acceptance v0.1 自动化测试 2026-06-14\",\"contact\":\"[email protected]\"}" -w "\n%{http_code}" 2>/dev/null)
  RPT_CODE=$(echo "$RESP" | tail -1)
  check "6.2 举报成功 (200)" "echo '$RPT_CODE' | grep -q '200'"
  BAD_CODE=$(curl -sS -X POST "$URL/api/reports" -H "Content-Type: application/json" -d "{\"post_id\":\"$ID\"}" -o /dev/null -w "%{http_code}")
  check "6.3 缺 reason 返 400" "echo '$BAD_CODE' | grep -q '400'"
fi

echo
echo "=== 7. SEO (首页) ==="
check "7.1 title 含搭子" "grep -q '同城搭子\\|找搭子' /tmp/acc_home.html"
check "7.2 description meta 存在" "grep -q 'meta name=\"description\"' /tmp/acc_home.html"

echo
echo "=== 8. 移动端基础 ==="
check "8.1 viewport meta" "grep -q 'name=\"viewport\"' /tmp/acc_home.html"

echo
echo "============================================"
echo "✅ PASS: $PASS, ❌ FAIL: $FAIL"
echo "============================================"
[ $FAIL -eq 0 ] && echo "🎉 v0.1 验收通过" || echo -e "⚠️ 失败项:$FAILED_LIST"
exit $FAIL
