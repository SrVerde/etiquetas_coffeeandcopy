/**
 * diagnose-codepage.js
 *
 * Prints a code-page diagnostic ticket.
 * Each line switches to a different ESC t code page then prints the same
 * Spanish test string. Look at the printout and find which line is correct.
 * Then open main.js and set CODE_PAGE to that number.
 *
 * Run:  node diagnose-codepage.js
 */

import { execFile }          from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir }            from 'node:os';
import { join }              from 'node:path';

const PRINTER_UNC = process.argv[2] ?? '\\\\DESKTOP-973O2DT\\ticket';
const TEMP_FILE   = join(tmpdir(), `cp-diag-${Date.now()}.bin`);

const ESC = 0x1B, GS = 0x1D, LF = 0x0A;

function buildDiagnostic() {
  const parts = [];
  const raw  = (...b)  => parts.push(Buffer.from(b));
  const text = (s, enc='ascii') => { parts.push(Buffer.from(s, enc)); raw(LF); };

  // Reset printer
  raw(ESC, 0x40);
  // Center alignment
  raw(ESC, 0x61, 1);
  raw(GS, 0x21, 0x11); // double width for header
  text('CODE PAGE DIAGNOSTIC');
  raw(GS, 0x21, 0x00); // normal size
  text('Find the line with correct accents');
  text('Expected: a-acute e-acute i-acute o-acute u-acute n-tilde');
  raw(LF);

  // The target Spanish string — bytes are identical in latin1 / PC850 / PC858 / Win-1252
  const spanishBytes = Buffer.from('  áéíóúñÑ¿¡  <- correct?', 'latin1');

  // Code pages to test — all candidates that include Spanish characters
  const candidates = [
    [0,  'PC437  (US Standard)'],
    [2,  'PC850  (Multilingual) *common*'],
    [16, 'WPC1252(Windows Latin-1) *Win*'],
    [17, 'PC866  (Cyrillic)'],
    [18, 'PC852  (Latin-2)'],
    [19, 'PC858  (Multilingual+Euro)'],
    [20, 'ISO8859-2'],
    [21, 'PC862  (Hebrew)'],
    [32, 'PC1250 (Windows Central EU)'],
    [33, 'PC1251 (Windows Cyrillic)'],
    [34, 'PC1253 (Windows Greek)'],
    [35, 'PC1254 (Windows Turkish)'],
    [36, 'PC1255 (Windows Hebrew)'],
  ];

  raw(ESC, 0x61, 0); // left align for tests
  for (const [n, name] of candidates) {
    raw(ESC, 0x74, n);     // ← switch code page
    raw(ESC, 0x52, 8);     // Spain international charset
    const label = `t${String(n).padStart(2,'0')} ${name}: `;
    parts.push(Buffer.from(label, 'ascii'));
    parts.push(spanishBytes);
    raw(LF);
  }

  raw(LF);
  raw(ESC, 0x61, 1);
  text('Set CODE_PAGE in main.js to the');
  text('number of the correct line above.');
  raw(LF, LF, LF, LF);
  raw(GS, 0x56, 0x00); // full cut

  return Buffer.concat(parts);
}

async function main() {
  try {
    const buf = buildDiagnostic();
    console.log(`Diagnostic buffer: ${buf.length} bytes`);
    await writeFile(TEMP_FILE, buf);

    await new Promise((resolve, reject) => {
      execFile('cmd', ['/c', 'copy', '/b', TEMP_FILE, PRINTER_UNC],
        (err, stdout, stderr) => {
          unlink(TEMP_FILE).catch(() => {});
          if (err) reject(new Error(`copy failed: ${stderr.trim() || err.message}`));
          else { console.log('cmd:', stdout.trim()); resolve(); }
        }
      );
    });

    console.log('✅  Diagnostic ticket sent. Check the printout.');
    console.log('    Find the line with correct á é í ó ú ñ ¿ ¡');
    console.log('    Then set CODE_PAGE to that number in main.js');
    process.exit(0);

  } catch (err) {
    console.error(`❌  ${err.message}`);
    process.exit(1);
  }
}

main();
