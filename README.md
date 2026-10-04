# Etiquetas · Coffee and Copy

Servidor de red local para diseñar e imprimir **etiquetas adhesivas** en una impresora térmica genérica ESC/POS (POS80, USB `VID 0416 / PID 5011`) conectada a una PC con Windows.

- **Editor web** en `http://etiquetas.local`: texto con tamaño, alineación y negrita, separadores y espacios, vista previa del sticker, plantillas guardadas, variables `{{campo}}`, copias.
- **Se imprime desde cualquier equipo de la red** con un navegador. No hace falta instalar nada en los otros equipos.
- **Dos vías de envío:** USB directo (sin la cola de impresión de Windows) o la cola compartida de Windows (`\\PC\ticket`).
- **Márgenes por software,** calibrados para el sticker. Salen idénticos por USB y por la cola compartida.
- Sin dependencias para el servidor. `sharp` solo se usa para imprimir imágenes.

## Requisitos

- Windows 10/11 con la impresora conectada por USB (driver `usbprint` de Windows).
- [Node.js](https://nodejs.org) 20 o superior.
- Para imprimir por la cola compartida: impresora `ticket` instalada con el driver **Generic / Text Only** y compartida.

## Instalación

```bat
git clone https://github.com/SrVerde/etiquetas_coffeeandcopy.git
cd etiquetas_coffeeandcopy
npm install          :: solo necesario si vas a imprimir imágenes
```

### Probar a mano

Doble clic en `iniciar-servidor.cmd` (o `npm start`) y abre <http://etiquetas.local>.

### Dejarlo como servidor permanente

Doble clic en **`instalar-servicio.cmd`**. Pide permisos de administrador y hace lo siguiente:

1. Crea la tarea **"Servidor de etiquetas"**. Arranca al encender la PC como `SYSTEM`, sin ventana y aunque nadie inicie sesión, y se reinicia sola si falla.
2. Abre en el firewall **TCP 80** (la página) y **UDP 5353** (el nombre `etiquetas.local`). Quita los bloqueos a Node.js que crea el aviso de Windows en redes públicas.
3. Comprueba que el servidor responde y que el nombre resuelve.

`desinstalar-servicio.cmd` deshace todo lo anterior.

### Actualizar

Doble clic en **`actualizar.cmd`**. Hace `git pull` (solo avance rápido: si hay cambios locales que chocan, se detiene sin tocar nada) y reinicia la tarea "Servidor de etiquetas" (pide permisos de administrador). Al final comprueba que el servidor responde y que `etiquetas.local` resuelve.

## Uso

| Desde | Dirección |
|---|---|
| Cualquier equipo de la red | `http://etiquetas.local` |
| Alternativa por nombre o IP | `http://DESKTOP-973O2DT` · `http://192.168.1.208` |

El nombre `etiquetas.local` lo anuncia el propio servidor por mDNS (`mdns.js`), sin tocar el router. Lo resuelven Windows 10/11, macOS, iOS, Android y Linux. Si alguna red no lo resuelve, usa la IP. Para que la IP no cambie, conviene reservarla en el DHCP del router.

### Línea de comandos

```bat
node main.js plantillas\ejemplo.json            :: vía definida en la plantilla
node main.js plantillas\ejemplo.json --usb      :: forzar USB directo (solo en la PC de la impresora)
node main.js plantillas\ejemplo.json --unc=\\DESKTOP-973O2DT\ticket
```

### API HTTP

```http
POST http://etiquetas.local/api/print
Content-Type: application/json

{ "template": "ejemplo", "data": { "producto": "Café de olla", "precio": "45.00" }, "copies": 2 }
```

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/config` | Columnas, vía por defecto, nombre del equipo |
| `GET` | `/api/templates` | Lista de plantillas |
| `GET / PUT / DELETE` | `/api/templates/:nombre` | Leer, guardar (`{ "ticket": [...] }`) o borrar |
| `POST` | `/api/print` | `ticket` o `template`, más `data`, `copies` y `transport` (`"usb"` o `"unc"`) |

## Configuración — `server-config.json`

```json
{
  "port": 80,
  "mdnsName": "etiquetas",
  "transport": "usb",
  "usbMatch": "vid_0416&pid_5011",
  "maxCopies": 100,
  "printer": {
    "unc": "\\\\localhost\\ticket",
    "codePage": 16,
    "charSet": 8,
    "marginLeftDots": 60,
    "printWidthDots": 456,
    "paperWidth": 38,
    "padding": 0
  }
}
```

- `codePage: 16` (WPC1252) imprime bien los acentos y la ñ en esta impresora.
- **Área del sticker:** la cabeza imprime 576 puntos (48 columnas de 12 puntos) y el sticker mide unos 494 puntos. Con `marginLeftDots: 60` + `printWidthDots: 456` quedan **38 columnas** centradas en la cabeza.
- Si el rollo se recorre de lado y se corta texto, ajusta `marginLeftDots` de 12 en 12. Lo mejor es fijar el rollo en la guía para que no tenga juego.
- `npm run calibrar` imprime una regla a todo el ancho para volver a medir.

## Formato de plantillas

Las plantillas son JSON (`plantillas/*.json`): un objeto `printer` y una lista `ticket` de elementos (`text`, `separator`, `feed`, `row`, `barcode`, `qr`, `image`, `cut`). Ver **[SCHEMA.md](SCHEMA.md)**.

En las filas (`row`), el ancho de las columnas debe sumar `paperWidth` (38).

## Estructura

```
server.js              servidor HTTP + API + cola de impresión
mdns.js                anunciador mDNS (etiquetas.local)
printer.js             JSON → ESC/POS, márgenes por software, envío USB/UNC
usb-send.ps1           escritura RAW a la interfaz USB (Win32 CreateFile/WriteFile)
main.js                impresión desde la línea de comandos
public/index.html      editor web
plantillas/            plantillas guardadas desde el editor
ejemplos/              plantillas de ejemplo (ticket, prueba de sticker)
herramientas/          calibración del área de impresión
servicio.ps1           instalación / desinstalación / reinicio del arranque automático
actualizar.cmd         git pull + reinicio de la tarea del servidor
diagnose-codepage.js   prueba de páginas de códigos
```

## Notas técnicas

- **USB directo:** escribe en `GUID_DEVINTERFACE_USBPRINT` con `CreateFile`/`WriteFile` a través de PowerShell. Node no puede abrir esa ruta de dispositivo directamente.
- **Cola compartida:** `copy /b archivo \\PC\ticket`. El driver Generic / Text Only pasa los bytes tal cual (RAW). En esta impresora, por esa vía se **ignoran `GS L` / `GS W`**, por eso los márgenes se calculan por software (`marginMode: "software"`, el valor por defecto).
- Registro de impresiones y errores en `logs/servidor.log` (rota a `.old` al pasar de 5 MB).
