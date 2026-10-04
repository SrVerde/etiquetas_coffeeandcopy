# Ticket Template JSON Schema

## Top-level structure

```json
{
  "printer": { ... },
  "ticket":  [ ...elements ]
}
```

---

## `printer` object

| Field            | Type          | Default                    | Description |
|---|---|---|---|
| `unc`            | string        | —                          | Windows UNC printer queue, e.g. `\\DESKTOP-973O2DT\ticket` (in JSON: `"\\\\DESKTOP-973O2DT\\ticket"`). Works on this PC and from other PCs on the network. |
| `usb`            | bool / string | `false`                    | `true` = send straight to the USB printer (VID 0416 / PID 5011) without the spooler, or a `"vid_xxxx&pid_xxxx"` filter. Only on the PC the printer is plugged into. Takes priority over `unc`. |
| `codePage`       | number        | `19`                       | ESC t code page. This printer: `16` (WPC1252). |
| `charSet`        | number        | `8`                        | ESC R international charset. `8` = Spain |
| `marginLeftDots` | number        | —                          | Left edge of the print area in dots (multiple of 12; 1 char = 12 dots). Sticker roll: `60`. |
| `printWidthDots` | number        | —                          | Width of the print area in dots. Sticker roll: `456` (38 chars). Images are scaled to this width. |
| `marginMode`     | string        | `"software"`               | `"software"` (USB and UNC) or `"hardware"` (GS L/GS W, USB only). See below. |
| `paperWidth`     | number        | `printWidthDots/12`, else `32` | Characters per line at normal size. |
| `padding`        | number        | `0`                        | Chars reserved on each side (word-wrap only). Leave at `0` when `marginLeftDots`/`printWidthDots` are set. |

At least one of `unc` or `usb` is required. CLI overrides: `node main.js plantilla.json --usb` or `--unc=\\PC\cola` (quote `--usb="vid_0416&pid_5011"` in cmd because of `&`).

**Row column widths must add up to `paperWidth − padding × 2`** (38 with the sticker settings).

### Sticker roll calibration (POS80, 576-dot head)

The adhesive sticker is narrower than the liner and covers roughly dots 40–540 of the 576-dot head (it drifts ±1–2 columns between prints). Settings in use: `marginLeftDots: 60` + `printWidthDots: 456` → 38 columns, centred on the head (dot 288), so barcodes and QR are centred too.

`marginMode`:
- `"software"` (default): printer.js places every text line with spaces and shifts images inside the bitmap. **Same result over USB and over the shared queue (UNC).** Use a `marginLeftDots` that is a multiple of 12.
- `"hardware"`: sends GS L / GS W. This printer only honours them over direct USB; jobs through the Windows shared queue ignore them.

---

## `ticket` array — element types

### `text` — a single line of text

```json
{ "type": "text",
  "value"    : "¡Hola mundo!",
  "align"    : "center",
  "bold"     : true,
  "underline": false,
  "size"     : [2, 1]
}
```

| Field       | Type            | Default  | Description |
|---|---|---|---|
| `value`     | string          | `""`     | Text content. Spanish/accented chars work natively. |
| `align`     | `left` `center` `right` | `left` | Text alignment |
| `bold`      | boolean         | `false`  | Bold on/off |
| `underline` | boolean         | `false`  | Underline on/off |
| `size`      | `[width, height]` | `[1,1]` | Multipliers 1–8. `[2,2]` = large, `[2,1]` = wide, `[1,2]` = tall |

---

### `separator` — a full-width horizontal rule

```json
{ "type": "separator", "char": "-" }
```

| Field  | Type   | Default | Description |
|---|---|---|---|
| `char` | string | `"-"`   | Character to repeat across the paper width |

---

### `feed` — blank lines

```json
{ "type": "feed", "lines": 2 }
```

| Field   | Type   | Default | Description |
|---|---|---|---|
| `lines` | number | `1`     | Number of blank lines to advance |

---

### `row` — multi-column fixed-width line

Ideal for receipt line items (description + quantity + price), key/value pairs, table headers.

```json
{ "type": "row",
  "bold": true,
  "columns": [
    { "text": "Producto",  "width": 20, "align": "left"  },
    { "text": "Uds",       "width": 5,  "align": "right" },
    { "text": "Precio",    "width": 7,  "align": "right" }
  ]
}
```

**Important:** column widths must add up to `printer.paperWidth` exactly, or the row will wrap/truncate.

#### Row-level fields

| Field       | Type    | Default | Description |
|---|---|---|---|
| `columns`   | array   | `[]`    | Column definitions (see below) |
| `bold`      | boolean | `false` | Applies bold to the entire assembled line |
| `underline` | boolean | `false` | Applies underline to the entire line |
| `align`     | —       | —       | Not used at row level; set per column |

#### Column fields

| Field   | Type                    | Default  | Description |
|---|---|---|---|
| `text`  | string                  | `""`     | Column content (truncated if too long) |
| `width` | number                  | required | Fixed character width of this column |
| `align` | `left` `center` `right` | `left`   | Text alignment within the column |

---

### `barcode` — CODE128 barcode

```json
{ "type"  : "barcode",
  "value" : "TICKET-001",
  "align" : "center",
  "height": 80,
  "width" : 2
}
```

| Field    | Type   | Default    | Description |
|---|---|---|---|
| `value`  | string | required   | Barcode content (ASCII printable) |
| `align`  | string | `"center"` | Left/center/right alignment |
| `height` | number | `80`       | Bar height in dots |
| `width`  | number | `2`        | Module width 1–6 (1=narrow, 3=wide) |

---

### `qr` — QR code

```json
{ "type"            : "qr",
  "value"           : "https://example.com",
  "align"           : "center",
  "module"          : 6,
  "errorCorrection" : "M"
}
```

| Field            | Type   | Default    | Description |
|---|---|---|---|
| `value`          | string | required   | Content to encode (URL, text, etc.) |
| `align`          | string | `"center"` | Alignment |
| `module`         | number | `6`        | Dot size 1–16. `4`=small, `6`=medium, `8`=large |
| `errorCorrection`| `L` `M` `Q` `H` | `"M"` | Error correction level. M (~15%) is a good default. Use H (30%) if the code may be partially obscured. |

---

### `image` — raster image (PNG, JPEG, WebP…)

```json
{ "type": "image", "path": "logo.png" }
```

| Field        | Type   | Default | Description |
|---|---|---|---|
| `path`       | string | required | Absolute path, or relative to the template's folder |
| `paperDots`  | number | `printWidthDots` | Override image width area in dots |
| `marginDots` | number | `0` with print area, else `16` | Dots left blank on each side |

Converted to 1-bit with Floyd–Steinberg dithering (needs `sharp`).

---

### `cut` — full paper cut

```json
{ "type": "cut" }
```

Always place this as the last element.

---

## Full minimal example

```json
{
  "printer": {
    "unc": "\\\\DESKTOP-973O2DT\\ticket",
    "codePage": 16,
    "marginLeftDots": 60,
    "printWidthDots": 456,
    "paperWidth": 38
  },
  "ticket": [
    { "type": "text", "value": "Mi Tienda", "align": "center", "bold": true, "size": [2,2] },
    { "type": "separator" },
    { "type": "row", "columns": [
      { "text": "Producto A", "width": 28, "align": "left" },
      { "text": "5.00",       "width": 10, "align": "right" }
    ]},
    { "type": "separator" },
    { "type": "row", "bold": true, "columns": [
      { "text": "TOTAL",  "width": 28, "align": "left" },
      { "text": "5.00",   "width": 10, "align": "right" }
    ]},
    { "type": "feed", "lines": 1 },
    { "type": "qr", "value": "https://mitienda.es" },
    { "type": "cut" }
  ]
}
```
