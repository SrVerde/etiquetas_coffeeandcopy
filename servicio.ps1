# servicio.ps1 - instala / desinstala el arranque automatico del servidor de etiquetas.
# Lo ejecutan instalar-servicio.cmd / desinstalar-servicio.cmd (como administrador).
param([ValidateSet('instalar','desinstalar')][string]$Accion = 'instalar')
$ErrorActionPreference = 'Stop'
$dir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$task  = 'Servidor de etiquetas'
$rules = 'Etiquetas - HTTP (TCP 80)', 'Etiquetas - mDNS (UDP 5353)'

function Stop-Servidor {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server\.js' } |
    ForEach-Object { Write-Host "  Deteniendo servidor anterior (PID $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Accion -eq 'desinstalar') {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Servidor
  foreach ($r in $rules) { Remove-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue }
  Write-Host "`nListo: el servidor ya no arranca solo y se quitaron sus reglas de firewall."
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'No se encontro node.exe. Instala Node.js primero.' }
Write-Host "Node:    $node"
Write-Host "Carpeta: $dir`n"

Write-Host '1) Cerrando servidores abiertos a mano...'
Stop-Servidor

Write-Host '2) Firewall...'
foreach ($r in $rules) { Remove-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue }
New-NetFirewallRule -DisplayName $rules[0] -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80   -Program $node -Profile Any | Out-Null
New-NetFirewallRule -DisplayName $rules[1] -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Program $node -Profile Any | Out-Null
Write-Host '   Permitido: TCP 80 (pagina) y UDP 5353 (etiquetas.local)'
# El aviso de Windows "permitir Node.js" crea reglas de BLOQUEO para los perfiles
# que no se marcaron (p. ej. red Publica). Un bloqueo gana sobre un permiso.
$blocks = Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
foreach ($b in $blocks) { Write-Host "   Quitando bloqueo previo de Node.js: $($b.DisplayName) [$($b.Profile)]"; Remove-NetFirewallRule -Name $b.Name }

Write-Host '3) Arranque automatico (tarea del sistema al encender la PC)...'
$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\server.js`"" -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Servidor LAN de etiquetas (http://etiquetas.local). Carpeta: node_escpos1' -Force | Out-Null
Start-ScheduledTask -TaskName $task
Write-Host '   Tarea creada e iniciada.'

Write-Host "`n4) Comprobando..."
Start-Sleep -Seconds 4
try {
  $r = Invoke-RestMethod -Uri 'http://localhost/api/config' -TimeoutSec 5
  Write-Host "   OK: el servidor responde en esta PC ($($r.host))."
} catch {
  Write-Host "   El servidor no responde todavia. Revisa $dir\logs\servidor.log" -ForegroundColor Yellow
}
# Resolve-DnsName solo consulta DNS clasico; el resolvedor del sistema (el de los navegadores) si usa mDNS
$ip = $null
for ($i = 0; $i -lt 5 -and -not $ip; $i++) {
  try { $ip = ([System.Net.Dns]::GetHostAddresses('etiquetas.local') | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1).IPAddressToString }
  catch { Start-Sleep -Seconds 1 }
}
if ($ip) { Write-Host "   OK: etiquetas.local -> $ip" }
else     { Write-Host '   etiquetas.local aun no resuelve en esta PC (puede tardar unos segundos).' -ForegroundColor Yellow }
Write-Host "`nListo. Abre  http://etiquetas.local  desde cualquier equipo de la red."
