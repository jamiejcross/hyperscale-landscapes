// Screenshot harness for the web app's 3D view (no dependencies: Node's
// built-in http server, fetch and WebSocket drive a headless Chrome over the
// DevTools protocol).
//
//   node tools/shoot.mjs                       # south-gyle and auchtertool-cato, field
//   node tools/shoot.mjs --style mossmorran
//   node tools/shoot.mjs --sites plean --label step1
//
// For each site it serves web/, opens ?site=<id>&style=<style>&az=313&el=35,
// selects the land-cover surface, waits for the model, and saves the 3D view
// at 2x to output/shots/<site>-<style>[-<label>].png. Rendering uses
// SwiftShader (software GL), so shots are repeatable on any machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web'), OUT = path.join(ROOT, 'output', 'shots');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SITES = opt('sites', 'south-gyle,auchtertool-cato').split(',');
const STYLE = opt('style', 'field'), LABEL = opt('label', ''), AZ = opt('az', '313'), EL = opt('el', '35');
const SURFACE = opt('surface', 'landcover');
const CHROME = opt('chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// ---- static server for web/ (no caching) ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.geojson': 'application/geo+json' };
const server = http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = path.join(WEB, p.endsWith('/') ? `${p}index.html` : p);
  if (!path.resolve(file).startsWith(WEB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- headless Chrome ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-shoot-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,1000', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
}
if (!port) throw new Error('Chrome did not start');
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'page error');
  return m.result?.result?.value;
};

// Runs in the page: wait for the model built from the URL, choose the
// surface, settle, and return the view at 2x as a PNG data URL.
const CAPTURE = surface => `(async () => {
  const wait = (f, ms = 120000) => new Promise((res, rej) => { const t0 = Date.now();
    (function poll() { try { if (f()) return res(); } catch {} if (Date.now() - t0 > ms) return rej(new Error('timed out')); setTimeout(poll, 200); })(); });
  await wait(() => window.__app?.model && window.__scene);
  const sf = document.getElementById('surface');
  if (sf.value !== ${JSON.stringify(surface)}) { sf.value = ${JSON.stringify(surface)}; sf.dispatchEvent(new Event('change')); }
  await wait(() => !/Loading/.test(document.getElementById('surface-note').textContent));
  await new Promise(r => setTimeout(r, 800));
  const sc = window.__scene; sc.pause();
  const c = sc.grab(2); sc.resume();
  return { png: c.toDataURL('image/png'), w: c.width, h: c.height, look: sc.view.look,
    angles: sc.cameraAngles(), status: document.getElementById('build-status').textContent };
})()`;

fs.mkdirSync(OUT, { recursive: true });
await send('Page.enable');
try {
  for (const site of SITES) {
    const url = `${base}/?site=${encodeURIComponent(site)}&style=${STYLE}&az=${AZ}&el=${EL}`;
    await send('Page.navigate', { url });
    await sleep(1500);
    const r = await evaluate(CAPTURE(SURFACE));
    const file = path.join(OUT, `${site}-${STYLE}${LABEL ? `-${LABEL}` : ''}.png`);
    fs.writeFileSync(file, Buffer.from(r.png.split(',')[1], 'base64'));
    console.log(`${path.relative(ROOT, file)}  ${r.w}×${r.h}  ${r.look}  az ${r.angles.az.toFixed(0)} el ${r.angles.el.toFixed(0)}  (${r.status})`);
  }
} finally {
  ws.close(); chrome.kill(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
