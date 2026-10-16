@echo off
setlocal
title TrackerBean registry setup
cd /d "%~dp0"

echo ============================================
echo   TrackerBean "Friend also has" setup
echo ============================================
echo.

if not exist "registry-worker\wrangler.toml" goto :wrongfolder
if not exist "src\social.js" goto :wrongfolder

where node >nul 2>nul
if errorlevel 1 goto :nonode

cd registry-worker

echo [1/4] Logging in to Cloudflare. A browser tab will open, click Allow.
call npx.cmd wrangler login
if errorlevel 1 goto :fail

findstr /c:"PASTE_KV_ID_HERE" wrangler.toml >nul
if errorlevel 1 (
  echo.
  echo [2/4] KV id is already set in wrangler.toml, skipping.
  goto :deploy
)

echo.
echo [2/4] Creating the USERS storage...
powershell -NoProfile -Command "& npx.cmd wrangler kv namespace create USERS 2>&1 | Tee-Object -FilePath kv.txt"

powershell -NoProfile -Command "$t=Get-Content kv.txt -Raw; if($t -match '(?i)\bid\W+([0-9a-f]{32})'){ $f=(Resolve-Path wrangler.toml).Path; [IO.File]::WriteAllText($f,(Get-Content $f -Raw).Replace('PASTE_KV_ID_HERE',$Matches[1])); exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo.
  echo Could not read the id automatically.
  set /p KVID=Paste the id that was printed above and press Enter: 
  set "TB_KVID=%KVID%"
  powershell -NoProfile -Command "$f=(Resolve-Path wrangler.toml).Path; [IO.File]::WriteAllText($f,(Get-Content $f -Raw).Replace('PASTE_KV_ID_HERE',$env:TB_KVID))"
)
echo KV id saved to wrangler.toml.

:deploy
echo.
echo [3/4] Deploying the worker...
powershell -NoProfile -Command "& npx.cmd wrangler deploy 2>&1 | Tee-Object -FilePath deploy.txt"

set "TB_URL="
for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "$t=Get-Content deploy.txt -Raw; if($t -match 'https://[A-Za-z0-9.-]+\.workers\.dev'){ $Matches[0] }"`) do set "TB_URL=%%U"

if not defined TB_URL (
  echo.
  echo Could not find the URL automatically.
  set /p TB_URL=Paste the workers.dev URL printed above and press Enter: 
)

echo.
echo [4/4] Putting %TB_URL% into src\social.js ...
powershell -NoProfile -Command "$f=(Resolve-Path ..\src\social.js).Path; $s=Get-Content $f -Raw; $rep='const REGISTRY_URL = ''' + $env:TB_URL + ''';'; [IO.File]::WriteAllText($f,[regex]::Replace($s,'const REGISTRY_URL\s*=\s*[^;]*;',$rep))"

del kv.txt >nul 2>nul
del deploy.txt >nul 2>nul

echo.
echo ============================================
echo   Done! Now build and release TrackerBean
echo   as normal, then upload the updated files.
echo ============================================
pause
exit /b 0

:wrongfolder
echo Could not find registry-worker\wrangler.toml and src\social.js.
echo Put this file in the same folder that contains "registry-worker" and "src", then run it again.
pause
exit /b 1

:nonode
echo Node.js is not installed. Get the LTS version from https://nodejs.org
echo Install it, then run this file again.
pause
exit /b 1

:fail
echo.
echo Something went wrong. Copy the message above and send it to Claude.
pause
exit /b 1
