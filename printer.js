/**
 * printer.js — Thermal Printer Library
 *
 * Converts a JSON ticket template into an ESC/POS byte buffer and sends it
 * to the printer through one of two transports:
 *
 *   UNC  — cmd /c copy /b <file> \\host\queue   (local or from other PCs)
 *   USB  — raw write to the printer's USB interface via usb-send.ps1
 *          (only on the PC the printer is plugged into; bypasses the spooler)
 *
 * Usage:
 *   import { printTicket, buildBuffer } from './printer.js';
 *
 *   await printTicket(template);                    // transport from template
 *   await printTicket(template, { usb: true });     // force USB
 *   await printTicket(template, { unc: '\\\\PC\\ticket' });
 *   const buf = await buildBuffer(template);        // raw buffer only
 *
 * ── Sticker rolls / print area ──────────────────────────────────────────────
 * When the printable sticker is narrower than the print head, set
 * printer.marginLeftDots (multiple of 12) + printer.printWidthDots.
 * By default (marginMode "software") printer.js places every text line with
 * computed spaces and shifts images inside the bitmap, so the result is the
 * same over direct USB and over the Windows shared queue (which ignores
 * GS L / GS W on this printer). Barcodes and QR stay centred by the printer.
 * paperWidth defaults to floor(printWidthDots / 12) chars; keep padding 0.
 *
 * ── Padding / margin design ────────────────────────────────────────────────
 * Thermal sticker/label rolls have a physical non-print zone (~2 mm) on each
 * side.  We model this with `printer.padding` (chars), which is used ONLY to
 * limit the word-wrap budget so text never reaches the edge.  All visual
 * alignment is delegated entirely to the printer via ESC a — we never bake
 * margin spaces into text strings.  This works correctly for normal text,
 * scaled text (GS !), and graphic elements (barcodes, QR) alike.
 */

import { execFile }          from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir }            from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath }     from 'node:url';
import { createRequire }     from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default USB printer (POS80, VID 0416 / PID 5011). Used when printer.usb === true.
export const DEFAULT_USB_MATCH = 'vid_0416&pid_5011';

// sharp is a globally-installed native module — load it via CJS require so it
// works inside an ES module without needing a local node_modules entry.
const _require = createRequire(import.meta.url);
let   _sharp;
try   { _sharp = _require('sharp'); }
catch { _sharp = null; }       // graceful: image elements will log a clear error

// ══════════════════════════════════════════════════════════════════════════════
//  ESC/POS constants
// ══════════════════════════════════════════════════════════════════════════════
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

const ALIGN_BYTE = { left: 0, center: 1, right: 2 };
const QR_EC_BYTE = { L: 48, M: 50, Q: 51, H: 52 };

// ══════════════════════════════════════════════════════════════════════════════
//  Image → ESC/POS  (sharp for decode, pure Node for dither + bitmap encode)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Convert any image file (JPEG, PNG, WebP, TIFF…) to an ESC/POS GS v 0
 * raster bitmap buffer.
 *
 * Decode:  sharp (globally installed, handles all common formats)
 * Dither:  Floyd-Steinberg, pure Node
 * Encode:  GS v 0, pure Node
 *
 * @param {string} path       Absolute path to the image file
 * @param {number} printDots  Width in dots of the printable area
 * @returns {Promise<Buffer>} ESC/POS bytes ready to write to the printer
 */
async function imageToEscPos(path, printDots, offsetDots = 0) {
  if (!_sharp) throw new Error('sharp is not available — run: npm install -g sharp');

  // Decode → grayscale → scale to printDots wide (sharp handles all formats)
  const { data, info } = await _sharp(path)
    .flatten({ background: { r: 255, g: 255, b: 255 } })  // transparent → white
    .grayscale()
    .resize(printDots, null, { fit: 'inside', kernel: 'lanczos3' })
    .normalise()          // autocontrast: stretch to 0–255
    .raw()
    .toBuffer({ resolveWithObject: true });

  const dstW = info.width;
  const dstH = info.height;

  // ── Floyd-Steinberg dither → 1-bit ────────────────────────────────────────
  const err  = new Float32Array(data);   // work copy (values 0–255)
  const dots = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const i   = y * dstW + x;
      const old = err[i];
      const nw  = old < 128 ? 0 : 255;
      dots[i]   = nw === 0 ? 1 : 0;     // 1 = black dot
      const e   = old - nw;
      if (x+1 < dstW)           err[i+1]      += e * 7/16;
      if (y+1 < dstH) {
        if (x > 0)              err[i+dstW-1] += e * 3/16;
                                err[i+dstW]   += e * 5/16;
        if (x+1 < dstW)         err[i+dstW+1] += e * 1/16;
      }
    }
  }

  // ── Pack into GS v 0 (raster bit image, normal density) ──────────────────
  // offsetDots: white columns added on the left (software margins), so the
  // image lands at an exact dot position with ESC a 0.
  const off      = Math.max(0, Math.round(offsetDots));
  const rowBytes = Math.ceil((off + dstW) / 8);
  const header   = Buffer.from([
    0x1D, 0x76, 0x30, 0x00,
    rowBytes & 0xFF, (rowBytes >> 8) & 0xFF,
    dstH     & 0xFF, (dstH     >> 8) & 0xFF,
  ]);
  const bmp = Buffer.alloc(rowBytes * dstH, 0);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const px = x + off;
      if (dots[y*dstW+x]) bmp[y*rowBytes + (px >> 3)] |= 0x80 >> (px & 7);
    }
  }
  return Buffer.concat([header, bmp]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Low-level ESC/POS byte builder
// ══════════════════════════════════════════════════════════════════════════════
class Builder {
  constructor() { this._parts = []; }

  push(...bufs) {
    for (const b of bufs)
      this._parts.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
    return this;
  }

  bytes(...vals) { return this.push(Buffer.from(vals)); }

  // ── Printer control ───────────────────────────────────────────────────────

  /** ESC @ — full printer reset */
  init() { return this.bytes(ESC, 0x40); }

  /** ESC t n — select code page (19=PC858, 2=PC850, 16=WPC1252) */
  codePage(n) { return this.bytes(ESC, 0x74, n); }

  /** ESC R n — international character set (8 = Spain) */
  charSet(n) { return this.bytes(ESC, 0x52, n); }

  /** GS L nL nH — left margin in dots */
  leftMargin(dots) { return this.bytes(GS, 0x4C, dots & 0xFF, (dots >> 8) & 0xFF); }

  /** GS W nL nH — print area width in dots */
  printWidth(dots) { return this.bytes(GS, 0x57, dots & 0xFF, (dots >> 8) & 0xFF); }

  // ── Text output ───────────────────────────────────────────────────────────

  /**
   * Print a latin1 string followed by LF.
   * latin1 maps accented chars (á=0xE1, ñ=0xF1…) to the same positions
   * used by PC850 / PC858 / WPC1252.
   */
  textLine(str) {
    return this.push(Buffer.from(str, 'latin1'), Buffer.from([LF]));
  }

  /** n blank lines */
  feed(n = 1) { return this.push(Buffer.alloc(n, LF)); }

  /** ESC a n — hardware alignment: 0=left 1=center 2=right */
  align(n) { return this.bytes(ESC, 0x61, n); }

  // ── Text style ────────────────────────────────────────────────────────────

  bold(on)     { return this.bytes(ESC, 0x45, on ? 1 : 0); }
  underline(n) { return this.bytes(ESC, 0x2D, n); }

  /**
   * GS ! n — character size multiplier (1–8 for width and height).
   * Call size(1,1) to restore normal size.
   */
  size(w, h) {
    return this.bytes(GS, 0x21, (((w - 1) & 0x07) << 4) | ((h - 1) & 0x07));
  }

  // ── Graphics ──────────────────────────────────────────────────────────────

  /** Native CODE128 barcode via GS k 73 */
  barcode128(data, height = 80, width = 2) {
    const payload = Buffer.concat([
      Buffer.from([0x7B, 0x42]),
      Buffer.from(data, 'ascii'),
    ]);
    return this
      .bytes(GS, 0x68, height)
      .bytes(GS, 0x77, width)
      .bytes(GS, 0x48, 2)
      .bytes(GS, 0x66, 0)
      .bytes(GS, 0x6B, 73, payload.length)
      .push(payload);
  }

  /** Native QR Code via GS ( k */
  qr(data, module = 6, ecByte = 50) {
    const url = Buffer.from(data, 'utf8');
    const cn  = 0x31;
    const sub = (fn, ...p) => {
      const body = [cn, fn, ...p];
      return Buffer.from([GS, 0x28, 0x6B,
        body.length & 0xFF, (body.length >> 8) & 0xFF, ...body]);
    };
    this.push(sub(0x41, 50, 0));
    this.push(sub(0x43, module));
    this.push(sub(0x45, ecByte));
    const storeBody = [cn, 0x50, 0x30, ...url];
    this.bytes(GS, 0x28, 0x6B,
      storeBody.length & 0xFF, (storeBody.length >> 8) & 0xFF);
    this.push(Buffer.from(storeBody));
    this.push(sub(0x51, 0x30));
    return this;
  }

  /** GS V 0 — full paper cut */
  cut() { return this.bytes(GS, 0x56, 0x00); }

  toBuffer() { return Buffer.concat(this._parts); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Word-wrap `text` into lines of at most `width` chars.
 * Tokens longer than `width` are hard-sliced so they are never dropped
 * (important for dates, codes, URLs that contain no spaces).
 */
function wrapWords(text, width) {
  if (width <= 0) return [''];
  const lines = [];
  let cur = '';
  for (const word of String(text ?? '').split(' ')) {
    let token = word;
    while (token.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(token.slice(0, width));
      token = token.slice(width);
    }
    if (!token) continue;
    const test = cur ? cur + ' ' + token : token;
    if (test.length > width) { if (cur) lines.push(cur); cur = token; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ══════════════════════════════════════════════════════════════════════════════
//  JSON → ESC/POS renderer
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Render one ticket element onto the Builder.
 *
 * @param {Builder} b
 * @param {object}  el          Element from the JSON template
 * @param {number}  paperWidth  Total chars per line at size 1×1
 * @param {number}  padding     Chars reserved on each side (wrap-budget only,
 *                              no spaces are emitted into the byte stream)
 */
async function renderElement(b, el, paperWidth, padding) {
  // innerWidth: maximum chars any line of text may use.
  // Kept smaller than paperWidth so text never reaches the physical
  // non-print border of sticker/label rolls.
  const innerWidth = paperWidth - padding * 2;
  const alignByte  = ALIGN_BYTE[el.align ?? 'left'] ?? 0;
  // Software margins: every text line is left-aligned (ESC a 0) and placed with
  // normal-size spaces computed here. Used when the printer (or the path to it)
  // does not honour GS L / GS W — e.g. jobs through the Windows shared queue.
  const soft = b._soft;
  const lead = n => ' '.repeat(Math.max(0, n));

  switch (el.type) {

    // ── text ─────────────────────────────────────────────────────────────────
    case 'text': {
      const [sw, sh] = el.size ?? [1, 1];
      const scaled   = sw > 1 || sh > 1;

      // Wrap budget shrinks with scale so the scaled glyphs don't exceed
      // innerWidth physical columns.
      const budget = Math.max(1, Math.floor(innerWidth / sw));

      if (soft) {
        for (const ln of wrapWords(el.value ?? '', budget)) {
          const free = Math.max(0, innerWidth - ln.length * sw);
          const off  = alignByte === 2 ? free : alignByte === 1 ? Math.floor(free / 2) : 0;
          b.align(0);
          b.push(Buffer.from(lead(soft.marginCols + padding + off), 'latin1'));  // normal size
          if (el.bold)      b.bold(true);
          if (el.underline) b.underline(1);
          if (scaled)       b.size(sw, sh);
          b.textLine(ln);
          if (scaled)       b.size(1, 1);
          if (el.underline) b.underline(0);
          if (el.bold)      b.bold(false);
        }
        break;
      }

      if (el.bold)      b.bold(true);
      if (el.underline) b.underline(1);

      for (const ln of wrapWords(el.value ?? '', budget)) {
        // Always set ESC a before each line to clear any stale alignment
        // state left by previous barcode/qr elements.
        b.align(alignByte);

        if (scaled) {
          // GS ! active: emit text directly — ESC a positions it.
          // Do NOT mix margin spaces into this textLine; the printer would
          // scale those spaces too, corrupting the position.
          b.size(sw, sh);
          b.textLine(ln);
          b.size(1, 1);
        } else {
          // Normal size: ESC a center/right work as-is.
          // For left alignment ESC a 0 starts at col 0 (the physical paper
          // edge), so we add padding spaces as a left indent.
          if (alignByte === 0 && padding > 0) {
            b.textLine(' '.repeat(padding) + ln);
          } else {
            b.textLine(ln);
          }
        }
      }

      if (el.bold)      b.bold(false);
      if (el.underline) b.underline(0);
      if (scaled)       b.size(1, 1);  // only emitted when GS! was used
      b.align(0);
      break;
    }

    // ── separator ─────────────────────────────────────────────────────────────
    case 'separator': {
      const char = (el.char ?? '-')[0];
      if (soft) {
        b.align(0);
        b.textLine(lead(soft.marginCols + padding) + char.repeat(innerWidth));
        break;
      }
      // A separator of innerWidth chars centred via ESC a 1 sits symmetrically
      // within the print area, leaving the padding margin on both sides.
      b.align(1);
      b.textLine(char.repeat(innerWidth));
      b.align(0);
      break;
    }

    // ── feed ──────────────────────────────────────────────────────────────────
    case 'feed': {
      b.feed(el.lines ?? 1);
      break;
    }

    // ── row ───────────────────────────────────────────────────────────────────
    case 'row': {
      // Column widths must sum to innerWidth.
      // Rows are left-aligned (ESC a 0) and prefixed with `padding` spaces
      // so the left edge of the row text respects the margin — identical
      // treatment to left-aligned text elements.
      const rowContent = (el.columns ?? [])
        .map(col => {
          const firstLine = wrapWords(col.text ?? '', col.width)[0] ?? '';
          const s   = firstLine.slice(0, col.width);
          const pad = col.width - s.length;
          if (col.align === 'right')  return s.padStart(col.width);
          if (col.align === 'center') return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
          return s.padEnd(col.width);
        })
        .join('');

      if (el.bold)      b.bold(true);
      if (el.underline) b.underline(1);

      b.align(0);
      b.textLine(lead((soft ? soft.marginCols : 0) + padding) + rowContent);

      if (el.bold)      b.bold(false);
      if (el.underline) b.underline(0);
      break;
    }

    // ── barcode ───────────────────────────────────────────────────────────────
    case 'barcode': {
      b.align(ALIGN_BYTE[el.align ?? 'center'] ?? 1);
      b.barcode128(el.value ?? '', el.height ?? 80, el.width ?? 2);
      b.align(0);
      break;
    }

    // ── qr ────────────────────────────────────────────────────────────────────
    case 'qr': {
      const ecByte = QR_EC_BYTE[el.errorCorrection ?? 'M'] ?? 50;
      b.align(ALIGN_BYTE[el.align ?? 'center'] ?? 1);
      b.qr(el.value ?? '', el.module ?? 6, ecByte);
      b.align(0);
      break;
    }

    // ── cut ───────────────────────────────────────────────────────────────────
    case 'cut': {
      // Feed before cutting so the last printed line clears the blade.
      // Default is 4 lines; override with { "type":"cut", "feed": n }.
      b.feed(el.feed ?? 4);
      b.cut();
      break;
    }

    // ── image ─────────────────────────────────────────────────────────────────
    case 'image': {
      // Renders any image (JPEG, PNG, WebP, TIFF…) as a 1-bit dithered
      // ESC/POS raster bitmap (GS v 0) via sharp + Floyd-Steinberg dither.
      //
      // Template fields:
      //   path        {string}  absolute path to the image file
      //   paperDots   {number}  override printer.paperDots  (optional)
      //   marginDots  {number}  override printer.marginDots (optional)
      const paperDots  = el.paperDots  ?? b._paperDots  ?? 384;
      const marginDots = el.marginDots ?? b._marginDots ?? 16;
      const printDots  = paperDots - marginDots * 2;

      // Relative paths resolve against the template's folder (opts.baseDir).
      const imgPath = isAbsolute(el.path ?? '') ? el.path : resolve(b._baseDir ?? '.', el.path ?? '');

      try {
        if (soft) {
          // Scale to the print area and shift by the margin inside the bitmap.
          const areaDots = el.paperDots ?? soft.areaDots;
          const buf = await imageToEscPos(imgPath, areaDots - (el.marginDots ?? 0) * 2,
                                          soft.marginDots + (el.marginDots ?? 0));
          b.align(0);
          b.push(buf);
        } else {
          const escposBuf = await imageToEscPos(imgPath, printDots);
          b.align(1);
          b.push(escposBuf);
        }
        b.align(0);
      } catch (err) {
        console.error(`[printer] image "${el.path}" failed: ${err.message}`);
      }
      break;
    }

    default:
      console.warn(`[printer] Unknown element type: "${el.type}" — skipped`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build an ESC/POS Buffer from a ticket template object.
 *
 * printer config fields:
 *   unc            {string}  Windows UNC path, e.g. \\PC-NAME\ticket  (UNC transport)
 *   usb            {bool|string} true or a "vid_xxxx&pid_xxxx" filter (USB transport)
 *   codePage       {number}  ESC t n  (default 19 = PC858)
 *   charSet        {number}  ESC R n  (default 8 = Spain)
 *   marginLeftDots {number}  left edge of the print area in dots (multiple of 12)
 *   printWidthDots {number}  width of the print area in dots
 *   marginMode     {string}  "software" (default, works over USB and UNC) or
 *                            "hardware" (GS L / GS W, direct USB only)
 *   paperWidth     {number}  chars per line at size 1×1
 *                            (default floor(printWidthDots/12), else 32)
 *   padding        {number}  chars reserved on each side   (default 0)
 *                            Limits word-wrap only. Not needed when the
 *                            hardware print area (GS L / GS W) is set.
 *
 * Row column widths must sum to (paperWidth − padding × 2).
 *
 * @param   {object} template
 * @param   {object} [opts]
 * @param   {string} [opts.baseDir]  folder used to resolve relative image paths
 * @returns {Promise<Buffer>}
 */
export async function buildBuffer(template, opts = {}) {
  const cfg        = template.printer ?? {};
  const elements   = template.ticket  ?? [];
  const codePage   = cfg.codePage   ?? 19;
  const charSet    = cfg.charSet    ?? 8;
  const areaDots   = cfg.printWidthDots;
  const paperWidth = cfg.paperWidth ?? (areaDots ? Math.floor(areaDots / 12) : 32);
  const padding    = cfg.padding    ?? 0;

  const b = new Builder();
  b._baseDir    = opts.baseDir;
  // Image width: the hardware print area if set, otherwise legacy paperDots/marginDots.
  b._paperDots  = cfg.paperDots  ?? areaDots ?? 384;   // 58mm@203dpi = 384
  b._marginDots = cfg.marginDots ?? (areaDots ? 0 : 16);

  b.init();
  b.codePage(codePage);
  b.charSet(charSet);
  b.codePage(codePage);   // sent twice — some printers ignore the first after reset

  // Print area for narrow sticker rolls.
  //   marginMode "software" (default): spaces / bitmap offset computed here —
  //     identical result over USB and over the Windows shared queue (UNC).
  //   marginMode "hardware": GS L / GS W — only honoured over direct USB on
  //     this printer; the shared queue path ignores them.
  const hasArea = cfg.marginLeftDots != null || areaDots != null;
  const mode    = cfg.marginMode ?? 'software';
  if (hasArea && mode === 'hardware') {
    // Must come after ESC @, which resets them
    if (cfg.marginLeftDots != null) b.leftMargin(cfg.marginLeftDots);
    if (areaDots != null)           b.printWidth(areaDots);
  } else if (hasArea) {
    const marginDots = cfg.marginLeftDots ?? 0;
    b._soft = {
      marginDots,
      marginCols: Math.round(marginDots / 12),       // use multiples of 12 for exactness
      areaDots:   areaDots ?? paperWidth * 12,
    };
  }

  for (const el of elements) {
    await renderElement(b, el, paperWidth, padding);
  }

  return b.toBuffer();
}

/** Run a command, resolve with trimmed stdout, reject with stderr. */
function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(
          `${label} failed (exit ${err.code}): ${(stderr || stdout).trim() || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Send a buffer to a Windows shared printer:  copy /b tmp \\host\queue */
export async function sendUnc(buf, unc) {
  const tmpFile = join(tmpdir(), `escpos-${Date.now()}.bin`);
  await writeFile(tmpFile, buf);
  try {
    return await run('cmd', ['/c', 'copy', '/b', tmpFile, unc], 'Printer copy');
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

/**
 * Send a buffer straight to the USB printer interface (GUID_DEVINTERFACE_USBPRINT)
 * using usb-send.ps1 (Win32 CreateFile/WriteFile). Only works on the PC the
 * printer is plugged into. `match` filters the device path (vid/pid).
 */
export async function sendUsb(buf, match = DEFAULT_USB_MATCH) {
  const tmpFile = join(tmpdir(), `escpos-${Date.now()}.bin`);
  await writeFile(tmpFile, buf);
  try {
    const out = await run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', join(__dirname, 'usb-send.ps1'), tmpFile, match,
    ], 'USB send');
    return out.split(/\r?\n/).pop();
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

/**
 * Build the buffer and send it. Transport priority:
 *   opts.usb / opts.unc  (e.g. CLI flags)  →  printer.usb  →  printer.unc
 *
 * @param   {object}  template
 * @param   {object}  [opts]  { usb, unc, baseDir }
 * @returns {Promise<string>} transport output (e.g. "1 file(s) copied")
 */
export async function printTicket(template, opts = {}) {
  const cfg = template.printer ?? {};
  let usb = opts.usb, unc = opts.unc;
  if (usb == null && unc == null) { usb = cfg.usb; unc = cfg.unc; }

  if (!usb && !unc) throw new Error('template.printer.unc or template.printer.usb is required');

  const buf = await buildBuffer(template, opts);
  if (usb) return sendUsb(buf, usb === true ? DEFAULT_USB_MATCH : usb);
  return sendUnc(buf, unc);
}
