@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0muvloom.ps1" %*
exit /b %ERRORLEVEL%
