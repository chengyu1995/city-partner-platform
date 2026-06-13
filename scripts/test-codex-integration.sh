#!/usr/bin/env bash
# test-codex-integration.sh
# 检查 OpenAI Codex GitHub App 是否成功集成到 chengyu1995/city-partner-platform
#
# 测的事:
#   1. CODEOWNERS 文件在仓库
#   2. AGENTS.md 在仓库
#   3. 仓库里 .github/workflows/ci.yml 存在
#   4. .github/ISSUE_TEMPLATE/agent-task.md 模板存在
#   5. (可选) 通过 gh CLI 看 GitHub App 是否装上
#   6. (可选) 验证 main 分支有保护规则
#
# 用法:
#   bash scripts/test-codex-integration.sh

set -uo pipefail

REPO="chengyu1995/city-partner-platform"
BRANCH="main"
PASS=0
FAIL=0
WARN=0

green() { printf "\033[32m%b\033[0m" "$1"; }
red()   { printf "\033[31m%b\033[0m" "$1"; }
yellow(){ printf "\033[33m%b\033[0m" "$1"; }
bold()  { printf "\033[1m%b\033[0m" "$1"; }

check() {
  local name="$1"
  local result="$2"  # ok / warn / fail
  local detail="${3:-}"
  case "$result" in
    ok)
      printf "  %s %s\n" "$(green '✓')" "$name"
      [ -n "$detail" ] && printf "      %s\n" "$detail"
      PASS=$((PASS+1))
      ;;
    warn)
      printf "  %s %s\n" "$(yellow '⚠')" "$name"
      [ -n "$detail" ] && printf "      %s\n" "$detail"
      WARN=$((WARN+1))
      ;;
    fail)
      printf "  %s %s\n" "$(red '✗')" "$name"
      [ -n "$detail" ] && printf "      %s\n" "$detail"
      FAIL=$((FAIL+1))
      ;;
  esac
}

header() { printf "\n%s\n" "$(bold "== $1 ==")"; }

header "1. 仓库基础设施文件"
[ -f AGENTS.md ] && check "AGENTS.md 存在" ok || check "AGENTS.md 存在" fail "需要 docs/CODEX_SETUP.md 第 3 步创建的规则文件"
[ -f .github/CODEOWNERS ] && check ".github/CODEOWNERS 存在" ok || check ".github/CODEOWNERS 存在" fail "Codex 改基础设施时的安全网"
[ -f .github/workflows/ci.yml ] && check ".github/workflows/ci.yml 存在" ok || check "CI workflow 存在" fail "Codex 提 PR 前需要 CI 验证"
[ -f .github/ISSUE_TEMPLATE/agent-task.md ] && check "Issue 模板 agent-task.md 存在" ok || check "Issue 模板" fail "Codex 接任务时用这个模板"
[ -f docs/CODEX_SETUP.md ] && check "docs/CODEX_SETUP.md 存在" ok || check "Codex 集成指南" fail "Codex 接 GitHub App 的步骤"

header "2. 仓库基础状态"
git rev-parse --is-inside-work-tree > /dev/null 2>&1 || { check "在 git 仓库里" fail "需要先 cd 进 city-partner-platform"; exit 1; }
check "在 git 仓库里" ok

REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [[ "$REMOTE_URL" == *"$REPO"* ]]; then
  check "remote 指向 $REPO" ok "$REMOTE_URL"
else
  check "remote 指向 $REPO" fail "当前: $REMOTE_URL"
fi

DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
if [ "$DEFAULT_BRANCH" = "main" ]; then
  check "默认分支 = main" ok
elif [ "$DEFAULT_BRANCH" = "dev" ]; then
  check "默认分支 = dev" warn "main 应是生产, dev 才是默认, 不一致. 建议把默认分支改回 main (per docs/GITHUB_SETUP.md)"
else
  check "默认分支 = $DEFAULT_BRANCH" warn "建议 main = 生产, dev = 默认"
fi

header "3. GitHub API 检查 (需要 gh CLI + auth)"
if command -v gh > /dev/null 2>&1; then
  if gh auth status > /dev/null 2>&1; then
    check "gh CLI 已登录" ok

    # 3a. Issue 模板列表
    ISSUES_TPL=$(gh api "repos/$REPO/issues/templates" 2>/dev/null | grep -oE '"name":"[^"]*"' | head -5)
    if echo "$ISSUES_TPL" | grep -q "agent-task"; then
      check "agent-task issue 模板注册" ok
    else
      check "agent-task 模板" warn "GitHub 还没识别, 等几分钟重试"
    fi

    # 3b. PR 模板
    PR_TPL=$(gh api "repos/$REPO/contents/.github/pull_request_template.md" 2>/dev/null | grep -oE '"name":"[^"]*"' | head -1)
    if [ -n "$PR_TPL" ]; then
      check "PR 模板存在" ok
    else
      check "PR 模板" fail
    fi

    # 3c. Codex GitHub App 是否装
    INSTALLATIONS=$(gh api "user/installations" 2>/dev/null | grep -oE '"app_slug":"[^"]*"' || echo "")
    if echo "$INSTALLATIONS" | grep -qi "codex\|openai"; then
      check "OpenAI Codex GitHub App 已装" ok
    else
      check "OpenAI Codex GitHub App" warn "未检测到. 去 https://chatgpt.com/codex 装 GitHub App"
      echo "      详细:"
      echo "$INSTALLATIONS" | sed 's/^/        /'
    fi

    # 3d. 分支保护
    BRANCH_PROTECTION=$(gh api "repos/$REPO/branches/main/protection" 2>/dev/null | grep -oE '"enforce_admins":[^,}]*|"required_pull_request_reviews":[^,}]*' | head -2)
    if [ -n "$BRANCH_PROTECTION" ]; then
      check "main 分支保护已配" ok "$(echo $BRANCH_PROTECTION | head -1)"
    else
      check "main 分支保护" warn "未配. 见 docs/GITHUB_SETUP.md 第 1 节"
    fi
  else
    check "gh CLI 已登录" warn "没登录, 跳到手动检查. 跑: gh auth login"
  fi
else
  yellow "  ⚠ gh CLI 没装\n"
  yellow "      跳到手动检查模式\n"
  yellow "      装: winget install GitHub.cli\n"
  yellow "      或: https://cli.github.com/\n"
  WARN=$((WARN+1))
fi

header "4. 本地代码自检"
LOCAL_NEXT_BUILD=$(test -d .next && echo "yes" || echo "no")
if [ "$LOCAL_NEXT_BUILD" = "yes" ]; then
  check ".next 存在 (本地 build 跑过)" ok
else
  check ".next 不存在" warn "跑 npm run build 本地验证"
fi

if command -v node > /dev/null 2>&1; then
  NODE_VER=$(node --version)
  check "Node 装好" ok "$NODE_VER"
  if [ -f package.json ]; then
    if [ -d node_modules ]; then
      check "node_modules 装好" ok
    else
      check "node_modules" fail "跑 npm install"
    fi
  fi
fi

if command -v npm > /dev/null 2>&1; then
  npm run lint > /dev/null 2>&1 && check "npm run lint 通过" ok || check "npm run lint" warn "有 lint 错"
  npm run build > /dev/null 2>&1 && check "npm run build 通过" ok || check "npm run build" warn "build 失败"
fi

header "5. Vercel 生产环境"
PROD_URL="https://city-partner-platform.vercel.app"
HTTP_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "$PROD_URL/" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  check "Vercel 生产环境 live" ok "$PROD_URL (HTTP 200)"
else
  check "Vercel 生产环境" warn "HTTP $HTTP_STATUS"
fi

ACT_DATA=$(curl -sS --max-time 10 "$PROD_URL/activities" 2>/dev/null | grep -oE 'e2e test|周末飞盘局（mock）' | head -1)
if [ "$ACT_DATA" = "e2e test" ]; then
  check "/activities 走真 Supabase" ok
elif [ "$ACT_DATA" = "周末飞盘局（mock）" ]; then
  check "/activities 走 MOCK 模式" warn "env vars 没生效, 走 mock. 见 docs/setup-supabase.md"
else
  check "/activities" warn "数据不确定"
fi

header "总结"
printf "  %s 通过,  %s 警告,  %s 失败\n" \
  "$(green "$PASS")" \
  "$(yellow "$WARN")" \
  "$(red "$FAIL")"
echo
if [ $FAIL -eq 0 ] && [ $WARN -eq 0 ]; then
  green "✓ 所有检查通过, Codex 可以接入了\n"
elif [ $FAIL -eq 0 ]; then
  yellow "⚠ 警告项需要看下, 但 Codex 可以接入\n"
  yellow "  最重要的是: OpenAI Codex GitHub App 是否装上\n"
else
  red "✗ 有失败项, 先修\n"
fi
echo
echo "下一步: 跟 docs/CODEX_SETUP.md 走 4 步:"
echo "  1. ChatGPT → Codex → 装 GitHub App"
echo "  2. GitHub App 6 个权限 (2b 表)"
echo "  3. Repository access: 选 $REPO only"
echo "  4. 用 agent-task.md 模板提个 issue, 看 Codex 接到没"
