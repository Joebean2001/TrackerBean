@echo off
setlocal
cd /d "%~dp0"
title TrackerBean test run
echo.
echo  TrackerBean test run (runs the new code straight from this folder)
echo  ------------------------------------------------------------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  goto end
)
taskkill /IM TrackerBean.exe /F >nul 2>nul
echo Step 1 of 2: installing packages (first time takes a minute)...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
echo.
echo Step 2 of 2: starting TrackerBean. Leave this window open while you test.
call npm start
goto end
:fail
echo.
echo Something went wrong. Take a photo or copy the text above and send it to Claude.
:end
echo.
pause
