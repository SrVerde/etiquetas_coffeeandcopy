@echo off
title Actualizar servidor de etiquetas
cd /d "%~dp0"
if /i "%~1"=="/reiniciar" goto reiniciar

rem 1) git pull como el usuario normal (sus credenciales y su configuracion de git)
where git >nul 2>&1
if %errorlevel% neq 0 (
  echo No se encontro git. Instala Git para Windows: winget install --id Git.Git -e
  pause
  exit /b 1
)
echo Descargando cambios de GitHub...
git pull --ff-only
if %errorlevel% neq 0 (
  echo.
  echo No se pudo actualizar. Si dice que hay cambios locales que se perderian
  echo ^(por ejemplo server-config.json o plantillas^), revisalos con:  git status
  echo El servidor NO se reinicio.
  pause
  exit /b 1
)

rem 2) reiniciar la tarea del sistema (pide permisos de administrador)
echo.
echo Reiniciando el servidor ^(pedira permisos de administrador^)...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '/reiniciar' -Verb RunAs -Wait"
exit /b

:reiniciar
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0servicio.ps1" -Accion reiniciar
echo.
pause
