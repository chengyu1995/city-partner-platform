@echo off
REM ============================================
REM 一键部署 city-partner-platform 到 Vercel
REM ============================================
REM
REM 用法:
REM   1. 第一次运行前,先登录 Vercel:
REM      npx vercel login
REM   2. 双击这个 .bat 文件
REM
REM 重要:
REM   - 部署会触发 Vercel 重新 build
REM   - 第一次部署会问 "Set up and deploy?" 输入 Y
REM   - 部署完成后主域名 https://city-partner-platform.vercel.app 自动更新
REM
REM 前提:
REM   - 你已经 git push 到 GitHub
REM   - Vercel 项目 page 已经在 "Connected Git Repository" 配了 main
REM   - 部署也可以从 Vercel 网页手动触发,无需这个脚本
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
echo === 3. 检查 Vercel CLI ===
where vercel >nul 2>nul
if errorlevel 1 (
  echo [INFO] vercel CLI 未装,装一个...
  call npm install -g vercel
  if errorlevel 1 (
    echo [ERROR] 装 vercel 失败
    exit /b 1
  )
)

echo.
echo === 4. 检查 Vercel 登录状态 ===
vercel whoami >nul 2>nul
if errorlevel 1 (
  echo [INFO] 未登录 Vercel,跳转到浏览器登录
  call vercel login
  if errorlevel 1 (
    echo [ERROR] 登录失败
    exit /b 1
  )
)

echo.
echo === 5. 部署到生产 ===
vercel deploy --prod --yes
if errorlevel 1 (
  echo [ERROR] 部署失败
  exit /b 1
)

echo.
echo === 6. 完成 ===
echo 主域名: https://city-partner-platform.vercel.app
echo 部署日志: https://vercel.com/chengyu1995/city-partner-platform-tfpf/deployments
echo.
echo 部署后验证:
echo   curl https://city-partner-platform.vercel.app/api/queue/status
echo.

endlocal
