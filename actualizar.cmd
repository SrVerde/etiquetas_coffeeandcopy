@echo off
title Actualizar servidor de etiquetas
cd /d "%~dp0"
if /i "%~1"=="reiniciar" goto reiniciar

echo 1) Descargando cambios de GitHub...
git pull --ff-only
if %errorlevel% neq 0 (
  echo.
  echo No se pudo actualizar. Revisa los mensajes de arriba
  echo ^(cambios locales en conflicto o sin conexion^). El servidor sigue igual.
  echo.
  pause
  exit /b 1
)

net session >nul 2>&1
if %errorlevel% equ 0 goto reiniciar
echo.
echo 2) Pidiendo permisos de administrador para reiniciar el servidor...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'reiniciar' -Verb RunAs"
exit /b

:reiniciar
echo 2) Reiniciando la tarea "Servidor de etiquetas"...
schtasks /end /tn "Servidor de etiquetas" >nul 2>&1
timeout /t 2 /nobreak >nul
schtasks /run /tn "Servidor de etiquetas"
if %errorlevel% neq 0 (
  echo No se encontro la tarea. Ejecuta instalar-servicio.cmd primero.
  echo.
  pause
  exit /b 1
)
timeout /t 4 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost/api/config' -TimeoutSec 5; Write-Host ('   OK: el servidor responde (' + $r.host + ').') } catch { Write-Host '   El servidor no responde todavia. Revisa logs\servidor.log' -ForegroundColor Yellow }"
echo.
pause
