@echo off
setlocal
cd /d "%~dp0"
title Move GameHub data to TrackerBean

echo.
echo  Move GameHub play time into TrackerBean
echo  ----------------------------------------
echo  Adds every game and session from GameHub to TrackerBean.
echo  Games in both apps are merged, and nothing is counted twice.
echo  TrackerBean's data file is backed up first.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install it from https://nodejs.org and try again.
  goto end
)
if not exist "%~dp0migrate-gamehub.js" (
  echo  migrate-gamehub.js must be in the same folder as this file.
  goto end
)
if not exist "%APPDATA%\gamehub\gamehub.json" (
  echo  Couldn't find GameHub's data:
  echo    %APPDATA%\gamehub\gamehub.json
  echo  Open GameHub once so it creates it, then run this again.
  goto end
)

rem --- both apps must be closed, or they would overwrite the result ---
set "RUNNING="
for %%P in (TrackerBean.exe GameHub.exe) do (
  tasklist /fi "imagename eq %%P" 2>nul | find /i "%%P" >nul && set "RUNNING=%%P"
)
if defined RUNNING (
  echo  %RUNNING% is still running. Quit it from the tray icon ^(right-click, Quit^), then run this again.
  goto end
)

node "%~dp0migrate-gamehub.js"
if errorlevel 1 (
  echo  Something went wrong, see the message above. TrackerBean's data was not changed.
  goto end
)
echo.
echo  Done. Open TrackerBean to see everything.

:end
echo.
pause
