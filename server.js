/**
 * server.js — Servidor LAN para diseñar e imprimir etiquetas.
 *
 *   node server.js            →  http://etiquetas.local  (mDNS)  ·  http://<esta-PC>
 *
 * Sin dependencias externas (solo Node). Reutiliza printer.js.
 * Configuración en server-config.json (se crea la primera vez).
 * Plantillas en la carpeta ./plantillas (mismo formato JSON que main.js).
 *
 * Acceso con PIN (auth.js): todo pide sesión salvo /login.html y /api/login.
 * El PIN se configura con  node herramientas/pin.js
 *
 * API
 *   POST   /api/login                  → { pin }  (crea la sesión)
 *   POST   /api/logout                 → cierra la sesión de este dispositivo
 *   GET    /api/config                 → columnas, transporte por defecto…
 *   GET    /api/templates              → ["etiqueta", …]
 *   GET    /api/templates/:nombre      → plantilla
 *   PUT    /api/templates/:nombre      → guarda { ticket: [...] }
 *   DELETE /api/templates/:nombre      → borra
 *   GET    /api/home                   → { template, ticket }  plantilla que se muestra en el inicio
 *   PUT    /api/home                   → { template }  elige la plantilla del inicio
 *   POST   /api/print                  → { ticket:[...] | template:"nombre", data:{campo:valor}, copies, transport:"usb"|"unc" }
 *
 * Variables automáticas (las llena el servidor al imprimir, con el reloj de esta PC):
 *   {{fecha}} → 03/10/2026   {{hora}} → 19:15   {{fecha_hora}} → 03/10/2026 19:15
 */

import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { buildBuffer, sendUsb, sendUnc, DEFAULT_USB_MATCH } from './printer.js';
import { startMdns } from './mdns.js';
import { createAuth } from './auth.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'server-config.json');
const TPL_DIR     = join(__dirname, 'plantillas');
const PUBLIC_DIR  = join(__dirname, 'public');
const LOG_DIR     = join(__dirname, 'logs');
const LOG_FILE    = join(LOG_DIR, 'servidor.log');
const DATA_DIR    = join(__dirname, 'datos');     // PIN, sesiones y plantilla del inicio (fuera del repo)
const HOME_PATH   = join(DATA_DIR, 'inicio.json');

// ── Registro: consola + logs/servidor.log (rota a .old al pasar de 5 MB) ────
mkdirSync(LOG_DIR, { recursive: true });
function log(...args) {
  const line = `${new Date().toLocaleString('es-MX')}  ${args.join(' ')}`;
  console.log(line);
  try {
    try { if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    appendFileSync(LOG_FILE, line + '\r\n');
  } catch {}
}
process.on('uncaughtException', e => { log(`[fatal] ${e.stack || e.message}`); process.exit(1); });

const DEFAULT_CONFIG = {
  port: 80,
  mdnsName: 'etiquetas',            // → http://etiquetas.local  ("" para desactivar)
  transport: 'usb',                 // "usb" (directo, esta PC) o "unc" (cola compartida)
  usbMatch: DEFAULT_USB_MATCH,
  maxCopies: 100,
  printer: {
    unc: '\\\\localhost\\ticket',
    codePage: 16,
    charSet: 8,
    marginLeftDots: 60,
    printWidthDots: 456,
    paperWidth: 38,
    padding: 0,
  },
};

// ── Config ───────────────────────────────────────────────────────────────────
async function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    else throw new Error(`server-config.json inválido: ${e.message}`);
  }
  return { ...DEFAULT_CONFIG, ...user, printer: { ...DEFAULT_CONFIG.printer, ...(user.printer ?? {}) } };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const NAME_RE = /^[\p{L}\p{N} _.-]{1,60}$/u;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
               '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function tplPath(name) {
  if (!NAME_RE.test(name) || name.startsWith('.')) throw Object.assign(new Error('Nombre de plantilla inválido'), { status: 400 });
  return join(TPL_DIR, `${name}.json`);
}

/** Sustituye {{campo}} por data.campo en todos los textos. */
function fillVars(value, data) {
  if (typeof value !== 'string' || !data) return value;
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (k in data ? String(data[k]) : m));
}

// Plantilla del inicio: la elegida en Avanzado (datos/inicio.json) o "inicio".
// Si el archivo de la plantilla no existe, se usa esta de respaldo.
const HOME_DEFAULT  = 'inicio';
const HOME_FALLBACK = [
  { type: 'feed', lines: 2 },
  { type: 'text', value: '{{texto}}', align: 'center', size: [2, 2], bold: true },
  { type: 'feed', lines: 2 },
  { type: 'text', value: '{{fecha_hora}}', align: 'center', size: [1, 1], bold: false },
  { type: 'cut' },
];
async function homeTemplateName() {
  try { return JSON.parse(await readFile(HOME_PATH, 'utf8')).template || HOME_DEFAULT; }
  catch { return HOME_DEFAULT; }
}

/** Variables automáticas: fecha y hora de esta PC en el momento de imprimir. */
function autoVars(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const fecha = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  const hora  = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return { fecha, hora, fecha_hora: `${fecha} ${hora}` };
}

const ALLOWED = new Set(['text', 'separator', 'feed', 'row', 'barcode', 'qr', 'cut']);

/** Valida y normaliza la lista de elementos (sin imágenes: no se leen archivos desde la web). */
function sanitizeTicket(ticket, data, cols) {
  if (!Array.isArray(ticket)) throw Object.assign(new Error('ticket debe ser una lista'), { status: 400 });
  if (ticket.length > 300)   throw Object.assign(new Error('Demasiados elementos'), { status: 400 });
  const out = [];
  for (const el of ticket) {
    if (!el || !ALLOWED.has(el.type)) continue;
    const e = { ...el };
    for (const k of ['value', 'char']) if (k in e) e[k] = fillVars(String(e[k] ?? ''), data).slice(0, 1000);
    if (e.type === 'text') {
      const [w, h] = Array.isArray(e.size) ? e.size : [1, 1];
      e.size  = [Math.min(8, Math.max(1, w | 0)), Math.min(8, Math.max(1, h | 0))];
      e.align = ['left', 'center', 'right'].includes(e.align) ? e.align : 'left';
      e.bold  = !!e.bold;
    }
    if (e.type === 'feed') e.lines = Math.min(20, Math.max(1, e.lines | 0 || 1));
    if (e.type === 'row' && Array.isArray(e.columns))
      e.columns = e.columns.map(c => ({ ...c, text: fillVars(String(c.text ?? ''), data) }));
    out.push(e);
  }
  // Cada etiqueta termina en corte
  if (!out.length || out[out.length - 1].type !== 'cut') out.push({ type: 'cut' });
  return out;
}

// Una impresión a la vez (USB y spooler no se mezclan)
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// ── Server ───────────────────────────────────────────────────────────────────
const config = await loadConfig();
await mkdir(TPL_DIR, { recursive: true });
const auth = createAuth(DATA_DIR, log);
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);   // ['api', ...]

  if (parts[1] === 'login' && req.method === 'POST') {
    const { status, body } = await auth.login(req, res, (await readBody(req, 1000)).pin);
    return send(res, status, body);
  }
  if (parts[1] === 'logout' && req.method === 'POST') {
    auth.logout(req, res);
    return send(res, 200, { ok: true });
  }

  if (parts[1] === 'config' && req.method === 'GET') {
    return send(res, 200, {
      columns: config.printer.paperWidth, transport: config.transport,
      maxCopies: config.maxCopies, host: os.hostname(),
    });
  }

  if (parts[1] === 'home' && req.method === 'GET') {
    const name = await homeTemplateName();
    try { return send(res, 200, { template: name, ticket: JSON.parse(await readFile(tplPath(name), 'utf8')).ticket ?? [] }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return send(res, 200, { template: null, ticket: HOME_FALLBACK });
  }
  if (parts[1] === 'home' && req.method === 'PUT') {
    const name = String((await readBody(req, 1000)).template ?? '');
    try { await readFile(tplPath(name)); }
    catch (e) { if (e.code === 'ENOENT') return send(res, 404, { error: 'Esa plantilla no existe' }); throw e; }
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(HOME_PATH, JSON.stringify({ template: name }, null, 2), 'utf8');
    log(`Plantilla del inicio: ${name}`);
    return send(res, 200, { ok: true, template: name });
  }

  if (parts[1] === 'templates') {
    const name = parts[2];
    if (!name && req.method === 'GET') {
      const files = (await readdir(TPL_DIR)).filter(f => f.endsWith('.json'));
      return send(res, 200, files.map(f => f.slice(0, -5)).sort((a, b) => a.localeCompare(b, 'es')));
    }
    if (name && req.method === 'GET') {
      try { return send(res, 200, JSON.parse(await readFile(tplPath(name), 'utf8'))); }
      catch (e) { if (e.code === 'ENOENT') return send(res, 404, { error: 'No existe' }); throw e; }
    }
    if (name && req.method === 'PUT') {
      const body = await readBody(req);
      if (!Array.isArray(body.ticket)) return send(res, 400, { error: 'Falta ticket' });
      const ticket = body.ticket.filter(e => e && ALLOWED.has(e.type));
      if (!ticket.length || ticket[ticket.length - 1].type !== 'cut') ticket.push({ type: 'cut' });
      // printer incluido para que la plantilla también se pueda imprimir con main.js
      const tpl = { printer: { ...config.printer }, ticket };
      await writeFile(tplPath(name), JSON.stringify(tpl, null, 2), 'utf8');
      return send(res, 200, { ok: true });
    }
    if (name && req.method === 'DELETE') {
      try { await unlink(tplPath(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'print' && req.method === 'POST') {
    const body = await readBody(req);
    let ticket = body.ticket;
    if (!ticket && body.template) ticket = JSON.parse(await readFile(tplPath(String(body.template)), 'utf8')).ticket;
    // las automáticas mandan: no se pueden escribir a mano
    const data      = { ...(body.data && typeof body.data === 'object' ? body.data : {}), ...autoVars() };
    const clean     = sanitizeTicket(ticket, data, config.printer.paperWidth);
    const copies    = Math.min(config.maxCopies, Math.max(1, body.copies | 0 || 1));
    const transport = body.transport === 'unc' || body.transport === 'usb' ? body.transport : config.transport;

    const one = await buildBuffer({ printer: config.printer, ticket: clean });
    const buf = Buffer.concat(Array(copies).fill(one));
    const who = req.socket.remoteAddress?.replace('::ffff:', '');

    const out = await enqueue(() => transport === 'usb'
      ? sendUsb(buf, config.usbMatch)
      : sendUnc(buf, config.printer.unc));
    log(`${who} → ${copies} etiqueta(s) por ${transport.toUpperCase()} (${buf.length} bytes)`);
    return send(res, 200, { ok: true, copies, transport, bytes: buf.length, result: out });
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

async function handleStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(PUBLIC_DIR, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido', 'text/plain');
  try {
    const data = await readFile(file);
    send(res, 200, data, MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Peticiones que cambian algo solo desde páginas de este mismo servidor
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== `http://${req.headers.host}`)
      return send(res, 403, { error: 'Origen no permitido' });

    if (!PUBLIC_PATHS.has(url.pathname) && !auth.session(req, res)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Inicia sesión con el PIN', login: true });
      res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET')        await handleStatic(req, res, url);
    else send(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    log(`[error] ${req.method} ${url.pathname}: ${e.message}`);
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') log(`[fatal] El puerto ${config.port} ya está en uso. Cambia "port" en server-config.json o cierra el otro programa.`);
  else log(`[fatal] ${e.message}`);
  process.exit(1);
});

server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => i.address);
  const p = config.port === 80 ? '' : `:${config.port}`;
  log('Servidor de etiquetas listo:');
  if (config.mdnsName) log(`  http://${config.mdnsName}.local${p}`);
  log(`  http://${os.hostname()}${p}`);
  for (const ip of ips) log(`  http://${ip}${p}`);
  log(`  Envío por defecto: ${config.transport.toUpperCase()}`);
  if (config.mdnsName) startMdns(config.mdnsName, log);
});
