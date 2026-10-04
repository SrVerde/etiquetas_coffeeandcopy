/**
 * main.js — Print a ticket from a JSON template file.
 *
 * Usage:
 *   node main.js                                   # prints ticket-example.json
 *   node main.js my-template.json                  # transport from the template
 *   node main.js my-template.json --usb            # force direct USB (this PC only)
 *   node main.js my-template.json --usb=vid_0416&pid_5011
 *   node main.js my-template.json --unc=\\PC-NAME\ticket   # force a UNC queue
 *
 * The template path is resolved relative to the current folder first, then to
 * THIS script's folder. Relative image paths resolve against the template's folder.
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }    from 'node:url';
import { printTicket, DEFAULT_USB_MATCH } from './printer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse arguments ──────────────────────────────────────────────────────────
const opts = {};
let templateArg = './ticket-example.json';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--usb')                 opts.usb = true;
  else if (a.startsWith('--usb='))   opts.usb = a.slice(6) || true;
  else if (a === '--unc')            opts.unc = args[++i];
  else if (a.startsWith('--unc='))   opts.unc = a.slice(6);
  else                               templateArg = a;
}

async function findTemplate(arg) {
  for (const p of [resolve(process.cwd(), arg), resolve(__dirname, arg)]) {
    try { await access(p); return p; } catch {}
  }
  return resolve(__dirname, arg);
}

async function main() {
  const templatePath = await findTemplate(templateArg);
  let template;

  try {
    template = JSON.parse(await readFile(templatePath, 'utf8'));
  } catch (err) {
    console.error(`❌  Could not load template "${templatePath}": ${err.message}`);
    process.exit(1);
  }

  const cfg = template.printer ?? {};
  const forced = opts.usb != null || opts.unc != null;
  const usb = forced ? opts.usb : cfg.usb;
  const unc = forced ? opts.unc : cfg.unc;
  const target = usb ? `USB (${usb === true ? DEFAULT_USB_MATCH : usb})` : unc;

  try {
    console.log(`Printing "${templatePath}" → ${target} …`);
    const result = await printTicket(template, { ...opts, baseDir: dirname(templatePath) });
    console.log(`✅  Done. ${result}`);
  } catch (err) {
    console.error(`❌  ${err.message}`);
    process.exit(1);
  }
}

main();
