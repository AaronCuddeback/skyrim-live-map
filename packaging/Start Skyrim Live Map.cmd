@echo off
rem Starts the Skyrim Live Map relay with the bundled Node.js. Close this window to stop it.
title Skyrim Live Map
chcp 65001 >nul

if not exist "%~dp0runtime\node\node.exe" goto missing
if not exist "%~dp0app\server\server.js" goto missing

cd /d "%~dp0app\server"
"%~dp0runtime\node\node.exe" server.js
if errorlevel 1 (
  echo.
  echo Skyrim Live Map stopped. Press any key to close.
  pause >nul
)
exit /b

:missing
echo Files are missing next to this script. Extract the whole archive
echo (keep the "app" and "runtime" folders beside it) and try again.
echo.
pause
exit /b 1
