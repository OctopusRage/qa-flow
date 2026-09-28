// Copied into every run folder by qa-flow and invoked through ./pw. Runs the Playwright CLI and
// masks secret variable values in its output, so the generating agent never reads them even when
// a spec prints its environment or an assertion echoes a typed password.
import { spawn } from 'node:child_process';

const vars = JSON.parse(process.env.QA_VARS ?? '{}');
const keys = JSON.parse(process.env.QA_SECRET_KEYS ?? '[]');
const secrets = keys
  .map((k) => vars[k])
  .filter((v) => typeof v === 'string' && v.length >= 3)
  // JSON-escaped forms too (error messages and reporters quote values).
  .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
  .sort((a, b) => b.length - a.length);
const mask = (text) => secrets.reduce((t, s) => t.split(s).join('••••••'), text);

const child = spawn(process.execPath, [process.env.QA_PW_CLI, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'pipe'] });

// Mask whole lines only, so a secret split across two chunks is still caught.
function pipe(from, to) {
  let buf = '';
  from.on('data', (chunk) => {
    buf += chunk.toString();
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) return;
    to.write(mask(buf.slice(0, cut + 1)));
    buf = buf.slice(cut + 1);
  });
  from.on('end', () => buf && to.write(mask(buf)));
}
pipe(child.stdout, process.stdout);
pipe(child.stderr, process.stderr);
child.on('close', (code) => process.exit(code ?? 1));
