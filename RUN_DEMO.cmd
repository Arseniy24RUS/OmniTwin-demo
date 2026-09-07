@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const m=Number(process.versions.node.split('.')[0]);process.exit(m>=24&&m<26?0:1)"
if errorlevel 1 goto missing_node
if not exist "node_modules\vite\package.json" (
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 goto failed
)
if not exist "apps\web\public\demo\dataset.json" (
  call npm run data:build
  if errorlevel 1 goto failed
)
call npm run dev --workspace @omnitwin/demo-web -- --open
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Node.js 24 LTS is required. Install it from https://nodejs.org/ and run this file again.
pause
exit /b 1
:failed
echo OmniTwin Demo did not start. See the error above. No model or unrelated process was stopped.
pause
exit /b 1
