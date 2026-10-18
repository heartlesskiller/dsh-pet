@echo off
rem ============================================================================
rem  open-admin.cmd -- desktop shortcut "中转站管理" actually runs THIS.
rem
rem  Why this exists: without it the shortcut pointed straight at node.exe, so a
rem  failure closed the console instantly and the user saw exactly "nothing
rem  happened" -- the same symptom we just fixed for the pet launcher. node
rem  prints the reason; this wrapper keeps the window alive so it can be read.
rem
rem  Pause rule: ANY non-zero exit pauses. open-admin.mjs exits
rem    0 = opened the browser
rem    1 = generic failure
rem    2 = port held by "someone else" (very likely the DSH host) -> guide the user
rem  So the check must be "not 0", never "==1".
rem
rem  Text here is ASCII-only on purpose: a batch file is read in the console
rem  code page, and Chinese here would garble. All Chinese comes from node,
rem  printed after `chcp 65001` below.
rem ============================================================================
chcp 65001 >nul
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] Node.js not found on PATH.
  echo       Install Node.js 22+ ^(https://nodejs.org^) and double-click again.
  echo.
  pause
  endlocal
  exit /b 9009
)

node "%~dp0open-admin.mjs"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo   ------------------------------------------------------------
  echo   The admin page was NOT opened. See the reason above.
  echo   ------------------------------------------------------------
  echo.
  pause
)

endlocal & exit /b %RC%
