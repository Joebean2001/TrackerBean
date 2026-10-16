@echo off
setlocal
cd /d "%~dp0"
title TrackerBean updater

echo.
echo  TrackerBean updater
echo  ---------------
echo  1. Download the newest trackerbean.zip from the chat (it goes to your Downloads folder)
echo  2. Double-click this file
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  goto end
)

rem --- find the newest trackerbean*.zip in Downloads ---
set "ZIP="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "Get-ChildItem ($env:USERPROFILE + '\Downloads\trackerbean*.zip') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"`) do set "ZIP=%%F"
if not defined ZIP (
  echo Could not find a trackerbean zip in your Downloads folder.
  echo Download the new trackerbean.zip from the chat first, then run this again.
  goto end
)
echo Using: %ZIP%

rem --- unpack and copy over this folder (keeps node_modules, skips this script) ---
set "TMPDIR=%TEMP%\trackerbean-update"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:TMPDIR -Force"
if errorlevel 1 goto fail
if not exist "%TMPDIR%\trackerbean\package.json" (
  echo The zip doesn't look like a TrackerBean update.
  goto fail
)
robocopy "%TMPDIR%\trackerbean" "%~dp0." /E /XD node_modules dist /XF update.bat >nul
if errorlevel 8 goto fail
rmdir /s /q "%TMPDIR%"

rem --- build ---
echo.
echo Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

if exist dist rmdir /s /q dist
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo.
echo Building the new version, this takes a minute...
call npm run build
if errorlevel 1 goto fail

rem --- install over the old version ---
set "SETUP="
for /f "delims=" %%F in ('dir /b /o-d "dist\*Setup*.exe" 2^>nul') do if not defined SETUP set "SETUP=dist\%%F"
if not defined SETUP (
  echo Build finished but no installer was found in the dist folder.
  goto fail
)

echo.
echo Closing TrackerBean and installing...
taskkill /IM TrackerBean.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul
start /wait "" "%SETUP%" /S

set "APP=%LOCALAPPDATA%\Programs\TrackerBean\TrackerBean.exe"
if exist "%APP%" (
  echo Updated. Starting TrackerBean...
  start "" "%APP%"
) else (
  echo Installer finished. Open TrackerBean from the Start menu.
  echo If it did not update, run the installer in the dist folder by hand.
  start "" "dist"
)
echo.
echo Your games, history, journal and settings were kept.
goto end

:fail
echo.
echo Something failed. Scroll up for the error message.
echo If it mentions a symbolic link, right-click update.bat and choose Run as administrator.

:end
echo.
pause
