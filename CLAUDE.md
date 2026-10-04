# CLAUDE.md — Contexto del proyecto (etiquetas · Coffee and Copy)

Este archivo resume una sesión previa de trabajo con Claude (en la nube, sin terminal en la PC) para que una sesión local de Claude Code continúe sin perder contexto. Idioma del usuario: **español**.

## Qué es

Servidor LAN + librería ESC/POS para imprimir **etiquetas adhesivas** en una impresora térmica genérica conectada por USB a la PC del taller. Editor web en `http://etiquetas.local`, impresión por USB directo o por la cola compartida de Windows. Ver `README.md` (uso) y `SCHEMA.md` (formato de plantillas).

Repositorio: https://github.com/SrVerde/etiquetas_coffeeandcopy (rama `main`).

## Hardware y PC (verificado)

- **Impresora:** POS80, USB `VID_0416&PID_5011` (serie 83700000000), driver Windows `usbprint`, puerto **USB002**. Cabeza de 576 puntos (48 columnas de 12 puntos, fuente A).
- Interfaz USB: `\\?\USB#VID_0416&PID_5011#83700000000#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}` (GUID_DEVINTERFACE_USBPRINT).
- **Colas en USB002:** `ticket` (Generic / Text Only, **compartida**, RAW, la que se usa), `POS-80` y `POS-58` (no se usan).
- `\\192.168.1.100\ticket` es **otra PC** con otra impresora (BTP-2002NP). **No imprimir ahí.**
- Hay un paquete libusb en `C:\Users\Taller\usb_driver`, pero la impresora usa `usbprint`. **No cambiar el driver** (rompería las colas de Windows).
- **PC:** `DESKTOP-973O2DT`, IP `192.168.1.208` por **DHCP** (recomendado reservarla en el router), red Ethernet con perfil **Público**, Node v24, usuario `Taller` (posiblemente sin contraseña, lo que impide el acceso SMB desde otras PCs).

## Hallazgos importantes

1. **`codePage: 16` (WPC1252)** imprime bien acentos y ñ. El texto se codifica en latin1.
2. **Por la cola compartida (UNC) la impresora IGNORA `GS L` / `GS W`**; por USB directo sí los respeta. Por eso `printer.js` usa **márgenes por software** (`marginMode: "software"`, el valor por defecto): espacios calculados para el texto y desplazamiento dentro del bitmap para las imágenes. El código de barras y el QR se centran con `ESC a 1` sobre la cabeza.
3. **El sticker** mide unos 494 puntos (~62 mm) y es más angosto que el papel de respaldo. **El rollo tiene ~6 mm de juego y el sticker se recorre ±1–2 columnas** entre impresiones. Configuración actual: `marginLeftDots: 60`, `printWidthDots: 456` → **38 columnas** centradas en la cabeza. El usuario quedó en fijar el rollo en la guía; si lo fija pegado al lado izquierdo, conviene `marginLeftDots: 36`.
4. El texto doble ancho alineado a la derecha con `ESC a 2` se desborda en el firmware; con márgenes por software se calcula a mano y sale bien.
5. **Node no puede abrir la ruta del dispositivo USB** (`fs.open` → `UNKNOWN`). El envío USB se hace con `usb-send.ps1` (`CM_Get_Device_Interface_List` + `CreateFile`/`WriteFile` vía Add-Type).
6. `Resolve-DnsName` **no** consulta mDNS. Para comprobar `etiquetas.local` usa `[System.Net.Dns]::GetHostAddresses()`, `ping` o el navegador.
7. Con poco avance antes del corte, el texto debajo del código de barras se corta. `cut` avanza 4 líneas por defecto; súbelo si el código de barras es lo último.
8. PowerShell 5.1 lee los `.ps1` sin BOM como ANSI: **los `.ps1` deben ser solo ASCII**. Los `.cmd` y `.ps1` van con CRLF (`.gitattributes`).

## Arquitectura

- `printer.js` — JSON → ESC/POS (`buildBuffer`), envío `sendUsb` / `sendUnc`, `printTicket`.
- `server.js` — HTTP sin dependencias: estáticos de `public/`, CRUD de `plantillas/*.json`, `POST /api/print` con cola (una impresión a la vez), variables `{{campo}}`, copias. Registro en `logs/servidor.log`. Config en `server-config.json` (puerto 80, `mdnsName: "etiquetas"`, transporte por defecto `usb`).
- `auth.js` — PIN (scrypt, `datos/pin.json`) + sesiones persistentes por cookie (`datos/sesiones.json`, solo SHA-256 del token, atadas al PIN) + bloqueo por IP tras 5 fallos. Todo pide sesión salvo `/login.html` y `/api/login`. PIN con `cambiar-pin.cmd` / `herramientas/pin.js`.
- `mdns.js` — anunciador mDNS propio (A + NSEC para AAAA) en UDP 5353.
- `public/index.html` — **inicio** para los empleados: campos generados de la plantilla del inicio (`{{var}}` → campo "Var" con su tipo de letra, sin llaves), vista previa con placeholders, botón Imprimir (Enter imprime). Pensado para que no intimide: nada de configuración a la vista.
- Plantilla del inicio: `datos/inicio.json` (`{ template }`, se elige con "Usar en inicio" en Avanzado); por defecto `plantillas/inicio.json` (2 líneas, `{{texto}}` 2×2 negrita centrado, 2 líneas, `{{fecha_hora}}` normal centrado). Si no existe, `server.js` usa una copia interna.
- Variables automáticas `{{fecha}}`, `{{hora}}`, `{{fecha_hora}}` (dd/mm/aaaa HH:MM, reloj de la PC): `autoVars()` en `server.js` al imprimir, con prioridad sobre `data`. Las páginas tienen una copia de `autoVars()` solo para la vista previa y no las piden como campos.
- `public/avanzado.html` — editor (vanilla JS, sin CDNs), con botón "← Inicio": texto con tamaño/alineación/negrita, separador, espacio, vista previa de 38 columnas, plantillas, copias, Ctrl+S / Ctrl+P.
- `main.js` — CLI: `node main.js plantilla.json [--usb | --unc=\\PC\cola]`.
- `servicio.ps1` + `instalar-servicio.cmd` / `desinstalar-servicio.cmd` — tarea programada al arrancar (SYSTEM, reinicio cada minuto si falla) y reglas de firewall TCP 80 + UDP 5353. Quita las reglas de **bloqueo** a node.exe que crea el aviso del firewall.
- `herramientas/calibracion.js` — regla a todo el ancho (`npm run calibrar`).

## Estado (3 oct 2026, sesión local con Claude Code)

- ✅ Impresión probada por USB y por UNC; las dos salen idénticas con márgenes por software.
- ✅ Editor web probado: imprimió desde la interfaz.
- ✅ `C:\Users\Taller\Desktop\node_escpos1` es copia de trabajo del repo (rama `main`, sigue a `origin/main`). Git 2.55 con `user.name SrVerde`.
- ✅ Archivos viejos (`printer_test*`, `image.png`, `.rar`, respaldos de vim, `_claude_test/`, JSON duplicados de la raíz) movidos a `_archivo\`, excluido solo localmente en `.git/info/exclude`.
- ✅ Tarea **"Servidor de etiquetas"** instalada (SYSTEM, al arrancar) y reglas de firewall creadas. Un usuario sin elevar no puede consultar la tarea (`Get-ScheduledTask`/`schtasks` → acceso denegado); para comprobarla, mira que el proceso node del puerto 80 tenga como padre `svchost` y revisa `logs\servidor.log`.
- ✅ `actualizar.cmd`: `git pull --ff-only` como usuario normal y luego reinicia la tarea con UAC. Probado.
- ✅ `http://etiquetas.local` responde en esta PC.
- ✅ Probado desde un celular en la red: `http://etiquetas.local` abre.
- ✅ Acceso con PIN implementado (los clientes del café comparten la red). La cola compartida `ticket` da permiso de imprimir a Todos y SMB está abierto en el firewall; hoy solo lo frena que `Taller` no tiene contraseña e Invitado está desactivado. Si se le pone contraseña a `Taller`, revisar la cola.
- ✅ Probado: tras reiniciar la PC el servidor arranca solo.
- ✅ Inicio simple (campo grande + Imprimir) y Avanzado separados; fecha y hora automáticas. Impresión real desde el inicio verificada.

## Pendientes sugeridos

1. Opcional: reserva DHCP, ajustar el margen cuando se fije el rollo.

## Cómo probar

```bat
node main.js ejemplos\prueba-sticker.json --usb
node main.js ejemplos\prueba-sticker.json --unc=\\DESKTOP-973O2DT\ticket
curl http://localhost/api/config
powershell -c "[System.Net.Dns]::GetHostAddresses('etiquetas.local')"
type logs\servidor.log
```

Cada prueba gasta un sticker: imprime solo lo necesario y pide al usuario una foto para verificar márgenes.
