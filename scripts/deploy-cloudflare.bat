@echo off
REM ============================================
REM 一键部署 city-partner-platform 到 Cloudflare Pages
REM ============================================
REM
REM 用法:
REM   1. 第一次运行前,先登录 Cloudflare:
REM      npx wrangler login
REM   2. 双击这个 .bat 文件
REM
REM 重要:
REM   - 部署会触发 Cloudflare Pages 重新 build
REM   - 部署完成后域名 https://city-partner-platform.pages.dev 自动更新
REM   - 不像 Vercel Hobby 那样 Block bot 触发!
REM
REM 前提:
REM   - 你已经在 https://dash.cloudflare.com 建好 Pages 项目
REM   - Pages 项目 connect 到了 chengyu1995/city-partner-platform repo
REM   - 4 个环境变量在 dashboard 配好
REM
REM ============================================

setlocal

cd /d "%~dp0\.."

echo.
echo === 1. 检查 git 状态 ===
git status --short
if errorlevel 1 (
  echo [ERROR] git 命令失败
  exit /b 1
)

echo.
echo === 2. 拉最新 main ===
git pull origin main
if errorlevel 1 (
  echo [WARNING] git pull 失败 (可能本地有未 push 改动) - 继续部署
)

echo.
echo === 3. 检查 wrangler CLI ===
where wrangler >nul 2>nul
if errorlevel 1 (
  echo [INFO] wrangler 未装,装一个...
  call npm install -g wrangler
  if errorlevel 1 (
    echo [ERROR] 装 wrangler 失败
    exit /b 1
  )
)

echo.
echo === 4. 检查 wrangler 登录状态 ===
wrangler whoami >nul 2>nul
if errorlevel 1 (
  echo [INFO] 未登录,跳转到浏览器登录
  call wrangler login
  if errorlevel 1 (
    echo [ERROR] 登录失败
    exit /b 1
  )
)

echo.
echo === 5. push 到 main (Cloudflare 自动 build) ===
git push origin main
if errorlevel 1 (
  echo [ERROR] git push 失败
  exit /b 1
)

echo.
echo === 6. 完成 ===
echo 主域名: https://city-partner-platform.pages.dev
echo 部署日志: https://dash.cloudflare.com/?to=/:account/pages/view/city-partner-platform
echo.
echo 部署后验证:
echo   curl https://city-partner-platform.pages.dev/api/queue/status
echo   curl https://city-partner-platform.pages.dev/activities
echo.
echo 部署通常 1-2 分钟. 在 Cloudflare dashboard 看实时状态.

endlocal
