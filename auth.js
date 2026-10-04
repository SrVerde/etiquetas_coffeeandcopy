/**
 * auth.js — Acceso al editor con PIN y sesión persistente, sin dependencias.
 *
 *   import { createAuth } from './auth.js';
 *   const auth = createAuth(join(__dirname, 'datos'), log);
 *   auth.session(req, res)        → sesión válida o null (renueva la cookie)
 *   auth.login(req, res, pin)     → { status, body }
 *   auth.logout(req, res)
 *
 * - El PIN se guarda con scrypt en datos/pin.json (lo crea herramientas/pin.js).
 * - Cada dispositivo recibe una cookie aleatoria de 32 bytes (HttpOnly,
 *   SameSite=Strict) válida un año desde el último uso. En datos/sesiones.json
 *   solo se guarda su SHA-256, así que el archivo no sirve para entrar.
 * - Las sesiones quedan atadas al PIN: al cambiarlo se cierran todas.
 * - Tras 5 PIN incorrectos desde una IP, espera de 1, 5, 15 y 60 minutos.
 */

import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT    = { N: 16384, r: 8, p: 1 };
const COOKIE    = 'etq_sesion';
const MAX_AGE   = 365 * 24 * 3600;              // segundos
const DAY       = 24 * 3600 * 1000;
const FREE_TRIES = 5;
const LOCK_MIN  = [1, 5, 15, 60];

export const PIN_RE = /^\d{6,12}$/;
export const pinFile = dir => join(dir, 'pin.json');

/** { salt, hash, N, r, p, creado } para guardar en datos/pin.json. */
export async function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), ...SCRYPT, creado: new Date().toISOString() };
}

const sha256 = s => createHash('sha256').update(s).digest('hex');
const ipOf   = req => req.socket.remoteAddress?.replace('::ffff:', '') ?? '?';

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (res, value, maxAge) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`);

export function createAuth(dir, log) {
  mkdirSync(dir, { recursive: true });
  const PIN_FILE = pinFile(dir);
  const SES_FILE = join(dir, 'sesiones.json');

  // PIN: se relee si herramientas/pin.js lo cambia con el servidor encendido
  let pin = null, pinMtime = -1;
  function currentPin() {
    let m = 0;
    try { m = statSync(PIN_FILE).mtimeMs; } catch { pin = null; pinMtime = -1; return null; }
    if (m !== pinMtime) {
      try { pin = JSON.parse(readFileSync(PIN_FILE, 'utf8')); pinMtime = m; }
      catch (e) { log(`[auth] datos/pin.json inválido: ${e.message}`); pin = null; }
    }
    return pin;
  }

  // Sesiones: { sha256(token): { pin: salt, creado, visto, ip, ua } }
  let sessions = {};
  try { sessions = JSON.parse(readFileSync(SES_FILE, 'utf8')); } catch {}
  let dirty = false;
  function save() {
    dirty = false;
    try { writeFileSync(SES_FILE + '.tmp', JSON.stringify(sessions, null, 1)); renameSync(SES_FILE + '.tmp', SES_FILE); }
    catch (e) { log(`[auth] no se pudo guardar sesiones: ${e.message}`); }
  }
  setInterval(() => { if (dirty) save(); }, 10 * 60 * 1000).unref();

  function session(req, res) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const id = sha256(token), s = sessions[id], p = currentPin();
    const now = Date.now();
    if (!s || !p || s.pin !== p.salt || now - s.visto > MAX_AGE * 1000) {
      if (s) { delete sessions[id]; save(); }
      return null;
    }
    // Renovación deslizante, como mucho una vez al día
    if (now - s.visto > DAY) { s.visto = now; dirty = true; setCookie(res, token, MAX_AGE); }
    return s;
  }

  const fails = new Map();   // ip → { n, until }
  async function login(req, res, input) {
    const ip = ipOf(req), now = Date.now();
    const f = fails.get(ip);
    if (f?.until > now) {
      const s = Math.ceil((f.until - now) / 1000);
      return { status: 429, body: { error: `Demasiados intentos. Espera ${s >= 90 ? Math.ceil(s / 60) + ' min' : s + ' s'}.` } };
    }
    const p = currentPin();
    if (!p) return { status: 503, body: { error: 'No hay PIN configurado. En la PC del taller: node herramientas/pin.js' } };

    const given = String(input ?? '');
    const hash  = await scryptAsync(given, Buffer.from(p.salt, 'hex'), 32, { N: p.N, r: p.r, p: p.p });
    if (!PIN_RE.test(given) || !timingSafeEqual(hash, Buffer.from(p.hash, 'hex'))) {
      const n = (f?.n ?? 0) + 1;
      const lock = n >= FREE_TRIES ? LOCK_MIN[Math.min(n - FREE_TRIES, LOCK_MIN.length - 1)] : 0;
      fails.set(ip, { n, until: lock ? now + lock * 60000 : 0 });
      log(`[auth] ${ip} PIN incorrecto (${n})${lock ? `, bloqueada ${lock} min` : ''}`);
      return { status: 401, body: { error: lock ? `PIN incorrecto. Espera ${lock} min.` : 'PIN incorrecto' } };
    }

    fails.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions[sha256(token)] = { pin: p.salt, creado: now, visto: now, ip, ua: String(req.headers['user-agent'] ?? '').slice(0, 200) };
    // Limpieza de sesiones vencidas o de PIN anteriores
    for (const [k, s] of Object.entries(sessions)) if (s.pin !== p.salt || now - s.visto > MAX_AGE * 1000) delete sessions[k];
    save();
    setCookie(res, token, MAX_AGE);
    log(`[auth] ${ip} inició sesión`);
    return { status: 200, body: { ok: true } };
  }

  function logout(req, res) {
    const token = readCookie(req, COOKIE);
    if (token && sessions[sha256(token)]) { delete sessions[sha256(token)]; save(); log(`[auth] ${ipOf(req)} cerró sesión`); }
    setCookie(res, '', 0);
  }

  return { session, login, logout };
}
