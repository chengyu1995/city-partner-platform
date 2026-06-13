#!/usr/bin/env bash
# ============================================
# 一键部署 city-partner-platform 到 Vercel (macOS/Linux)
# ============================================
#
# 用法:
#   1. 第一次运行前,先登录 Vercel:
#      npx vercel login
#   2. 运行这个脚本: ./scripts/deploy-vercel.sh
#

set -e

cd "$(dirname "$0")/.."

echo
echo "=== 1. 检查 git 状态 ==="
git status --short

echo
echo "=== 2. 拉最新 main ==="
git pull origin main || echo "[WARNING] git pull 失败,继续"

echo
echo "=== 3. 检查 Vercel CLI ==="
if ! command -v vercel >/dev/null 2>&1; then
  echo "[INFO] vercel CLI 未装,装一个..."
  npm install -g vercel
fi

echo
echo "=== 4. 检查 Vercel 登录状态 ==="
if ! vercel whoami >/dev/null 2>&1; then
  echo "[INFO] 未登录 Vercel,跳转到浏览器登录"
  vercel login
fi

echo
echo "=== 5. 部署到生产 ==="
vercel deploy --prod --yes

echo
echo "=== 6. 完成 ==="
echo "主域名: https://city-partner-platform.vercel.app"
echo "部署日志: https://vercel.com/chengyu1995/city-partner-platform-tfpf/deployments"
echo
echo "部署后验证:"
echo "  curl https://city-partner-platform.vercel.app/api/queue/status"
