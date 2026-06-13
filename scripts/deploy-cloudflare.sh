#!/usr/bin/env bash
# ============================================
# 一键部署 city-partner-platform 到 Cloudflare Pages (macOS/Linux)
# ============================================
#
# 用法:
#   1. 第一次运行前,先登录 Cloudflare:
#      npx wrangler login
#   2. 运行这个脚本: ./scripts/deploy-cloudflare.sh
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
echo "=== 3. 检查 wrangler CLI ==="
if ! command -v wrangler >/dev/null 2>&1; then
  echo "[INFO] wrangler 未装,装一个..."
  npm install -g wrangler
fi

echo
echo "=== 4. 检查 wrangler 登录状态 ==="
if ! wrangler whoami >/dev/null 2>&1; then
  echo "[INFO] 未登录,跳转到浏览器登录"
  wrangler login
fi

echo
echo "=== 5. push 到 main (Cloudflare 自动 build) ==="
git push origin main

echo
echo "=== 6. 完成 ==="
echo "主域名: https://city-partner-platform.pages.dev"
echo "部署日志: https://dash.cloudflare.com/?to=/:account/pages/view/city-partner-platform"
echo
echo "部署通常 1-2 分钟. 在 Cloudflare dashboard 看实时状态."
