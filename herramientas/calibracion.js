/**
 * herramientas/calibracion.js — Imprime una regla de calibración a todo el
 * ancho de la cabeza (576 puntos = 48 columnas, sin márgenes) para medir qué
 * parte cae sobre el sticker.
 *
 *   node herramientas/calibracion.js            # por USB directo
 *   node herramientas/calibracion.js --unc=\\PC\ticket
 *
 * Lee el primer y último número completo dentro del sticker y ajusta
 * printer.marginLeftDots / printWidthDots (1 columna = 12 puntos).
 */
import { sendUsb, sendUnc, DEFAULT_USB_MATCH } from '../printer.js';

const ESC = 0x1B, GS = 0x1D, LF = 0x0A, COLS = 48, DOTS = 576;
const parts = [];
const b = (...x) => parts.push(Buffer.from(x));
const t = s => { parts.push(Buffer.from(s, 'latin1')); b(LF); };

const tens  = Array.from({ length: COLS }, (_, i) => Math.floor((i + 1) / 10) % 10).join('');
const units = Array.from({ length: COLS }, (_, i) => (i + 1) % 10).join('');
const marks = Array.from({ length: COLS }, (_, i) => ((i + 1) % 5 === 0 ? '|' : '.')).join('');

function raster(w, h, on) {
  const rb = w / 8;
  b(GS, 0x76, 0x30, 0, rb & 255, rb >> 8, h & 255, h >> 8);
  const data = Buffer.alloc(rb * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) data[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  parts.push(data);
}
const tick = (x, y) => x % 12 < 2 && (x % 120 < 2 || (x % 60 < 2 ? y < 28 : y < 14));

b(ESC, 0x40); b(ESC, 0x74, 16);
b(ESC, 0x61, 1); b(ESC, 0x45, 1); t('CALIBRACION'); b(ESC, 0x45, 0); t('1 columna = 12 puntos'); b(LF);
b(ESC, 0x61, 0); t(tens); t(units); t(marks);
raster(DOTS, 40, tick); b(LF);
raster(DOTS, 24, () => true); b(LF);                  // barra a todo el ancho de la cabeza
t(tens); t(units); t(marks); b(LF);
b(ESC, 0x61, 1); t('Primer y ultimo numero COMPLETO'); t('visible dentro del sticker'); b(LF);
b(ESC, 0x61, 0); t('<IZQ'); b(ESC, 0x61, 2); t('DER>'); b(ESC, 0x61, 0);
b(LF, LF, LF, LF); b(GS, 0x56, 0);

const buf = Buffer.concat(parts);
const arg = process.argv.find(a => a.startsWith('--unc='));
const out = arg ? await sendUnc(buf, arg.slice(6)) : await sendUsb(buf, DEFAULT_USB_MATCH);
console.log(`Calibración enviada (${buf.length} bytes): ${out}`);
