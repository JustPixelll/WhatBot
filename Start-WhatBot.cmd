@echo off
setlocal
cd /d "%~dp0"
title WhatBot
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS or newer from https://nodejs.org/ then try again.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if errorlevel 1 (
  echo WhatBot needs Node.js 24 or newer. Update at https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\whatsapp-web.js\package.json" (
  echo Installing WhatBot and its browser. The first run may take a few minutes.
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Check the message above and your internet connection.
    pause
    exit /b 1
  )
)
node src/main.js %*
echo.
echo WhatBot has stopped.
pause
