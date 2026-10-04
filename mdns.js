/**
 * mdns.js — Anunciador mDNS mínimo (RFC 6762) sin dependencias.
 *
 * Hace que "<nombre>.local" resuelva a la IP de esta PC en la red local,
 * igual que hacen las impresoras o los equipos Apple. Windows 10/11, macOS,
 * iOS, Android y Linux (Avahi) lo resuelven sin configurar nada.
 *
 *   import { startMdns } from './mdns.js';
 *   startMdns('etiquetas', log);      // → etiquetas.local
 *
 * Solo responde registros A (IPv4). A las preguntas AAAA responde con un
 * NSEC ("no tengo IPv6") para que el cliente no espere.
 */

import dgram from 'node:dgram';
import os from 'node:os';

const GROUP = '224.0.0.251';
const PORT  = 5353;
const TTL   = 120;
const T_A = 1, T_AAAA = 28, T_NSEC = 47, T_ANY = 255;

/** IPv4 de la red local (sin loopback ni 169.254.x.x) con su máscara. */
function lanAddrs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => ({ address: i.address, netmask: i.netmask }));
}
const ip2n = ip => ip.split('.').reduce((a, b) => ((a << 8) | (+b & 255)) >>> 0, 0);
function sameSubnet(a, b, mask) { const m = ip2n(mask); return (ip2n(a) & m) === (ip2n(b) & m); }

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map(p => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

/** Lee un nombre DNS (con punteros de compresión). Devuelve [nombre, siguienteOffset]. */
function readName(buf, off) {
  const labels = []; let jumped = false, next = off, guard = 0;
  while (guard++ < 128) {
    if (off >= buf.length) throw new Error('nombre truncado');
    const len = buf[off];
    if (len === 0) { off += 1; break; }
    if ((len & 0xC0) === 0xC0) {
      const ptr = ((len & 0x3F) << 8) | buf[off + 1];
      if (!jumped) next = off + 2;
      jumped = true; off = ptr; continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), jumped ? next : off];
}

function parseQuestions(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;                  // es respuesta, no pregunta
  const qd = buf.readUInt16BE(4);
  const qs = []; let off = 12;
  for (let i = 0; i < qd; i++) {
    const [name, o] = readName(buf, off);
    if (o + 4 > buf.length) break;
    qs.push({ name: name.toLowerCase(), type: buf.readUInt16BE(o), qclass: buf.readUInt16BE(o + 2) });
    off = o + 4;
  }
  return { id: buf.readUInt16BE(0), qs };
}

function rr(nameBuf, type, cls, ttl, rdata) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(cls, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, h, rdata]);
}

function buildResponse({ fqdn, ip, kind, id = 0, legacyQuestion = null }) {
  const nameBuf = encodeName(fqdn);
  const legacy  = !!legacyQuestion;
  const cls     = legacy ? 0x0001 : 0x8001;          // bit cache-flush solo en multicast
  const answers = [];
  if (kind === 'A') answers.push(rr(nameBuf, T_A, cls, TTL, Buffer.from(ip.split('.').map(Number))));
  if (kind === 'NSEC') {
    // NSEC: siguiente nombre = el mismo; mapa de tipos con solo "A"
    const bitmap = Buffer.from([0x00, 0x01, 0x40]);
    answers.push(rr(nameBuf, T_NSEC, cls, TTL, Buffer.concat([nameBuf, bitmap])));
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(legacy ? id : 0, 0);
  header.writeUInt16BE(0x8400, 2);                   // respuesta + autoritativa
  header.writeUInt16BE(legacy ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  const q = legacy ? Buffer.concat([encodeName(legacyQuestion.name), Buffer.from([legacyQuestion.type >> 8, legacyQuestion.type & 255, 0, 1])]) : Buffer.alloc(0);
  return Buffer.concat([header, q, ...answers]);
}

/**
 * Arranca el anunciador. Devuelve { stop() }. Nunca lanza: si el puerto 5353
 * no está disponible, avisa por `log` y el servidor sigue funcionando por IP.
 */
export function startMdns(hostname, log = console.log) {
  const fqdn = `${String(hostname).toLowerCase().replace(/\.local$/, '')}.local`;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timers = [];

  const pickIp = remote => {
    const addrs = lanAddrs();
    return (addrs.find(a => remote && sameSubnet(a.address, remote, a.netmask)) ?? addrs[0])?.address;
  };

  const sendMulticast = msgFor => {
    for (const a of lanAddrs()) {
      try { sock.setMulticastInterface(a.address); sock.send(msgFor(a.address), PORT, GROUP); } catch {}
    }
  };

  const announce = () => sendMulticast(ip => buildResponse({ fqdn, ip, kind: 'A' }));

  sock.on('message', (msg, rinfo) => {
    let parsed;
    try { parsed = parseQuestions(msg); } catch { return; }
    if (!parsed) return;
    for (const q of parsed.qs) {
      if (q.name !== fqdn) continue;
      const kind = q.type === T_A || q.type === T_ANY ? 'A' : q.type === T_AAAA ? 'NSEC' : null;
      if (!kind) continue;
      const ip = pickIp(rinfo.address);
      if (!ip) return;
      const unicastAsked = (q.qclass & 0x8000) !== 0;
      if (rinfo.port !== PORT) {
        // Consulta "legacy" (desde un puerto que no es 5353): responder directo
        sock.send(buildResponse({ fqdn, ip, kind, id: parsed.id, legacyQuestion: q }), rinfo.port, rinfo.address);
      } else if (unicastAsked) {
        sock.send(buildResponse({ fqdn, ip, kind }), rinfo.port, rinfo.address);
      } else {
        sendMulticast(myIp => buildResponse({ fqdn, ip: myIp, kind }));
      }
    }
  });

  sock.on('error', err => {
    log(`[mDNS] no disponible (${err.code || err.message}); el servidor sigue accesible por IP o nombre de equipo`);
    try { sock.close(); } catch {}
  });

  sock.bind(PORT, () => {
    try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch {}
    let joined = 0;
    for (const a of lanAddrs()) { try { sock.addMembership(GROUP, a.address); joined++; } catch {} }
    if (!joined) { try { sock.addMembership(GROUP); joined++; } catch {} }
    log(`[mDNS] anunciando ${fqdn} → ${lanAddrs().map(a => a.address).join(', ') || '(sin red)'}`);
    // Anuncio inicial (2 veces) y refresco antes de que caduque el TTL
    announce();
    timers.push(setTimeout(announce, 1000));
    timers.push(setInterval(announce, (TTL / 2) * 1000));
  });

  return { fqdn, stop() { timers.forEach(clearInterval); try { sock.close(); } catch {} } };
}
