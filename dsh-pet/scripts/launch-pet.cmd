@echo off
rem ============================================================================
rem  launch-pet.cmd -- desktop shortcut "桌宠" actually runs THIS.
rem
rem  Why: a .mjs started directly from a shortcut leaves no window behind, so
rem  when it fails the console (and the reason) vanishes in a blink. This
rem  wrapper runs the launcher and, ONLY on failure, pauses so the user can
rem  actually read what went wrong.
rem
rem  Notes:
rem   - Text here is intentionally ASCII-only: the batch file is read in the
rem     console code page, and Chinese here would garble on some machines.
rem     All human-facing Chinese comes from node (launch-pet.mjs), printed
rem     after `chcp 65001` below.
rem   - Success path prints nothing extra and does NOT pause.
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

node "%~dp0launch-pet.mjs"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo   ------------------------------------------------------------
  echo   The pet did not start. See the reason above.
  echo   ------------------------------------------------------------
  echo.
  pause
)

endlocal & exit /b %RC%
