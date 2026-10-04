@echo off
title Desinstalar servidor de etiquetas
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0servicio.ps1" -Accion desinstalar
echo.
pause
