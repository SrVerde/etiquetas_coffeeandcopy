/**
 * herramientas/pin.js — Configura o cambia el PIN del editor web.
 *
 *   node herramientas/pin.js        (o  npm run pin)
 *
 * Pide el PIN dos veces (6 a 12 dígitos) y lo guarda con scrypt en
 * datos/pin.json. Al cambiarlo se cierran las sesiones de todos los
 * dispositivos. El servidor lo toma sin reiniciar.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPin, pinFile, PIN_RE } from '../auth.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'datos');

// Entrada redirigida (sin consola): se leen todas las líneas de una vez
let piped;
async function pipedLine() {
  if (!piped) { let s = ''; for await (const c of process.stdin) s += c; piped = s.split(/\r?\n/); }
  return (piped.shift() ?? '').trim();
}

/** Lee una línea sin mostrarla (asteriscos) si hay consola interactiva. */
function ask(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  if (!stdin.isTTY) return pipedLine().then(v => (stdout.write('\n'), v));
  return new Promise(resolve => {
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onKey = key => {
      for (const ch of key) {
        if (ch === '\u0003') { stdout.write('\n'); process.exit(1); }               // Ctrl+C
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onKey); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\b' || ch === '\u007f') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } }
        else if (ch >= ' ') { value += ch; stdout.write('*'); }
      }
    };
    stdin.on('data', onKey);
  });
}

const pin = await ask('Nuevo PIN (6 a 12 dígitos): ');
if (!PIN_RE.test(pin)) { console.error('El PIN debe tener de 6 a 12 dígitos, solo números.'); process.exit(1); }
if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin)) {
  console.error('Ese PIN es demasiado fácil de adivinar (repetido o consecutivo). Elige otro.'); process.exit(1);
}
if (await ask('Repite el PIN: ') !== pin) { console.error('No coinciden. No se cambió nada.'); process.exit(1); }

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(pinFile(DATA_DIR), JSON.stringify(await hashPin(pin), null, 2));
console.log('Listo: PIN guardado. Las sesiones anteriores quedaron cerradas.');
