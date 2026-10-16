@echo off
setlocal
cd /d "%~dp0"
title TrackerBean

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  goto end
)

if not exist node_modules (
  echo Installing packages, this takes a minute the first time...
  call npm install
  if errorlevel 1 goto fail
)

echo.
echo   1 - Test the app (opens TrackerBean now)
echo   2 - Build the .exe installer
echo.
choice /c 12 /n /m "Pick 1 or 2: "
if errorlevel 2 goto build

call npm start
goto end

:build
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run build
if errorlevel 1 goto fail
echo.
echo Done. Opening the dist folder - run the TrackerBean Setup file to install.
start "" "dist"
goto end

:fail
echo.
echo Something failed. Scroll up for the error message.
echo If it mentions a symbolic link, right-click build.bat and choose Run as administrator.

:end
echo.
pause
