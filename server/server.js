// Skyrim Live Map relay.
// Named pipe or UDP (from the SKSE plugin) -> WebSocket (to every browser on the LAN),
// plus a static file server for the map web app.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { WebSocketServer } from 'ws';
import { createMapBuilder } from './mapbuild.js';

const HTTP_PORT = Number(process.env.HTTP_PORT ?? process.env.PORT ?? 8787);
const UDP_PORT = Number(process.env.UDP_PORT ?? 27015);
const PIPE_NAME = process.env.PIPE_NAME ?? 'SkyrimLiveMap';

const here = path.dirname(fileURLToPath(import.meta.url));
// The packaged app (tools/package.ps1) has its own Node and Python in ..\..\runtime and
// keeps maps in %LOCALAPPDATA%, so it can live in any folder and survive updates.
const runtimeDir = path.join(here, '..', '..', 'runtime');
const packaged = fs.existsSync(path.join(runtimeDir, 'python', 'python.exe'));
const dataDir = path.resolve(process.env.SLM_DATA
  ?? (packaged ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'SkyrimLiveMap', 'maps') : path.join(here, '..', 'web', 'data')));
fs.mkdirSync(dataDir, { recursive: true });
process.env.SLM_DATA = dataDir; // the Python tools read and write maps here too
const toolsDir = path.join(here, '..', 'tools');
const venvPython = path.join(toolsDir, '.venv', 'Scripts', 'python.exe');
const python = packaged ? path.join(runtimeDir, 'python', 'python.exe') : fs.existsSync(venvPython) ? venvPython : 'python';

const roots = {
  '/vendor/three/': path.join(here, 'node_modules', 'three'),
  '/data/': dataDir,
  '/': path.join(here, '..', 'web'),
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function resolveStatic(urlPath) {
  for (const [prefix, dir] of Object.entries(roots)) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) return null; // path traversal guard
    return file;
  }
  return null;
}

let lastState = null;
let lastQuests = null; // quests and player stats arrive once a second; replay them to new viewers
let lastPlayer = null;

// Newest modification time of the web app's own files (not map data). Open pages
// poll this and reload themselves when it changes, so a companion screen that's
// been running for hours never keeps old code.
function appVersion() {
  const dir = roots['/'];
  let newest = 0;
  for (const name of fs.readdirSync(dir)) {
    if (/\.(js|css|html|webmanifest)$/.test(name)) newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
  }
  return String(Math.round(newest));
}

// ---------------------------------------------------------------- local maps
// Floor plans of interiors and buildings of outdoor cells, built on demand by
// tools/localmap.py (one long-lived Python worker) and cached under <maps>/<map>/local.
let worker = null;
let workerBuffer = '';
let nextRequest = 1;
const waiting = new Map();   // request id -> resolve
const inFlight = new Map();  // cache file name -> promise (one build per cell at a time)

function localWorker() {
  if (worker) return worker;
  worker = spawn(python, ['localmap.py', '--serve'], { cwd: toolsDir, windowsHide: true });
  // Building a map is a burst of CPU work; never let it compete with the game for a core.
  try { os.setPriority(worker.pid, os.constants.priority.PRIORITY_LOW); } catch { /* best effort */ }
  worker.stdout.on('data', (chunk) => {
    workerBuffer += chunk;
    let end;
    while ((end = workerBuffer.indexOf('\n')) >= 0) {
      const line = workerBuffer.slice(0, end);
      workerBuffer = workerBuffer.slice(end + 1);
      try {
        const reply = JSON.parse(line);
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      } catch { /* not a reply */ }
    }
  });
  worker.stderr.on('data', (d) => console.warn(`\n[localmap] ${d.toString().trim()}`));
  worker.on('exit', (code) => {
    console.warn(`\n[localmap] worker exited (${code})`);
    worker = null;
    for (const resolve of waiting.values()) resolve({ ok: false, error: 'local map worker stopped' });
    waiting.clear();
  });
  return worker;
}

const MAP_ID = /^[a-z0-9-]+$/;
const FORM_KEY = /^[^\\/:*?"<>|]+:[0-9A-F]{6}$/i;

function localMap(params) {
  const map = params.get('map') ?? '';
  if (!MAP_ID.test(map)) return Promise.resolve({ ok: false, error: 'bad map id' });
  let request, name;
  if (params.has('cell')) {
    const key = params.get('cell');
    if (!FORM_KEY.test(key)) return Promise.resolve({ ok: false, error: 'bad cell key' });
    request = { map, kind: 'interior', key };
    name = `i_${key.replace(':', '_')}`;
  } else {
    const world = params.get('world') ?? '';
    const x = Number.parseInt(params.get('x'), 10), y = Number.parseInt(params.get('y'), 10);
    if (!FORM_KEY.test(world) || !Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve({ ok: false, error: 'bad cell' });
    request = { map, kind: 'exterior', world, x, y };
    name = `e_${world.replace(':', '_')}_${x}_${y}`;
  }
  // Already built: answer from disk without the worker.
  const metaFile = path.join(dataDir, map, 'local', `${name}.json`);
  if (fs.existsSync(metaFile)) {
    return Promise.resolve({ ok: true, file: `${map}/local/${name}.bin.gz`, meta: JSON.parse(fs.readFileSync(metaFile, 'utf8')) });
  }
  const key = `${map}/${name}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, new Promise((resolve) => {
      const id = nextRequest++;
      waiting.set(id, resolve);
      localWorker().stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    }).finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/local') {
    localMap(url.searchParams).then((reply) => {
      res.writeHead(reply.ok ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(reply));
    });
    return;
  }
  if (url.pathname === '/api/rebuild' && req.method === 'POST') {
    const reply = maps.rebuild(url.searchParams.get('map') ?? '');
    res.writeHead(reply.ok ? 202 : 409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(reply));
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(lastState ?? '{}');
    return;
  }
  if (url.pathname === '/api/version') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ version: appVersion() }));
    return;
  }
  const file = resolveStatic(url.pathname);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const isData = file.startsWith(dataDir) || file.includes(`${path.sep}node_modules${path.sep}`);
    // App code is small: never cache it. Map data and three.js are big: revalidate
    // (they change when extract_map.py is re-run).
    const modified = stat.mtime.toUTCString();
    if (isData && req.headers['if-modified-since'] === modified) {
      res.writeHead(304).end();
      return;
    }
    // Local map geometry is stored gzipped; let the browser unpack it.
    const gzipped = file.endsWith('.bin.gz');
    res.writeHead(200, {
      'content-type': gzipped ? 'application/octet-stream' : mime[path.extname(file)] ?? 'application/octet-stream',
      ...(gzipped ? { 'content-encoding': 'gzip' } : {}),
      'content-length': stat.size,
      'cache-control': isData ? 'no-cache' : 'no-store',
      'last-modified': modified,
    });
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/live' });
wss.on('connection', (ws, req) => {
  console.log(`[ws] client connected from ${req.socket.remoteAddress} (${wss.clients.size} total)`);
  if (lastState) ws.send(lastState);
  if (lastQuests) ws.send(lastQuests);
  if (lastPlayer) ws.send(lastPlayer);
  if (maps.status) ws.send(JSON.stringify(maps.status));
  ws.on('close', () => console.log(`[ws] client left (${wss.clients.size} total)`));
});

function broadcast(text) {
  for (const client of wss.clients) {
    // Drop frames for slow clients instead of buffering stale positions.
    if (client.readyState === 1 && client.bufferedAmount < 256 * 1024) client.send(text);
  }
}

const maps = createMapBuilder({
  dataDir, python, toolsDir, broadcast,
  // A rebuilt map replaces the files the floor-plan worker has open: start it fresh.
  onBuilt: () => worker?.kill(),
});

let packets = 0;
let rejected = 0;

function forward(text, from) {
  let packet;
  try {
    packet = JSON.parse(text); // only forward well-formed packets
  } catch (err) {
    // Say so: a silently dropped packet is how actors vanished from the map.
    if (rejected++ < 5 || rejected % 100 === 0) {
      console.warn(`\n[${from}] rejected malformed packet #${rejected} (${text.length} chars, ${err.message}): ${text.slice(0, 160)}…`);
    }
    return;
  }
  const type = packet.t;
  if (type === 'state') {
    lastState = text;
    maps.onState(packet);
  }
  if (type === 'quests') lastQuests = text;
  if (type === 'player') lastPlayer = text;
  packets++;
  broadcast(text);
}

// The game on this PC hosts a named pipe and the relay connects to it: no network
// traffic, so ReShade's multiplayer guard doesn't disable its add-ons. The game hosts
// it so that permissions work whichever side runs as administrator.
// Frames are a 4-byte LE length + JSON.
const pipePath = `\\\\.\\pipe\\${PIPE_NAME}`;
let pipeWaiting = false;

function connectToGame() {
  const socket = net.connect(pipePath);
  let pending = Buffer.alloc(0);
  socket.on('connect', () => {
    pipeWaiting = false;
    console.log('\n[pipe] connected to the game');
  });
  socket.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (size > 16 * 1024 * 1024) {
        console.warn(`\n[pipe] bad frame length ${size}; reconnecting`);
        socket.destroy();
        return;
      }
      if (pending.length < 4 + size) break;
      forward(pending.toString('utf8', 4, 4 + size), 'pipe');
      pending = pending.subarray(4 + size);
    }
  });
  socket.on('error', (err) => {
    // ENOENT: the game isn't running (yet). Anything else is worth a line, once.
    if (!pipeWaiting && err.code !== 'ENOENT') console.warn(`\n[pipe] ${err.code ?? err.message}; retrying`);
  });
  socket.on('close', (hadError) => {
    if (!hadError) console.log('\n[pipe] game disconnected');
    if (!pipeWaiting) console.log(`[pipe] waiting for the game on ${pipePath}`);
    pipeWaiting = true;
    setTimeout(connectToGame, 1000);
  });
}
connectToGame();

// UDP is for a game on another computer (plugin ini: Transport=udp).
const udp = dgram.createSocket({ type: 'udp4', recvBufferSize: 1 << 20 });
udp.on('message', (msg) => forward(msg.toString('utf8'), 'udp'));
udp.on('error', (err) => {
  console.error(`[udp] ${err.message}`);
  process.exit(1);
});
udp.bind(UDP_PORT, () => console.log(`[udp] listening for a remote game on port ${UDP_PORT}`));

setInterval(() => {
  if (packets > 0) process.stdout.write(`\r[relay] ${packets} packets/5s from game, ${wss.clients.size} viewer(s)   `);
  packets = 0;
}, 5000);

// Real Wi-Fi/Ethernet adapters first; VPN and VM adapters aren't reachable from a phone.
const VIRTUAL_ADAPTER = /vpn|vmware|virtualbox|vethernet|wsl|hyper-v|tailscale|zerotier|docker|loopback/i;

function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).map((i) => ({ ...i, name })))
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .sort((a, b) => VIRTUAL_ADAPTER.test(a.name) - VIRTUAL_ADAPTER.test(b.name));
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `\nPort ${HTTP_PORT} is already in use: Skyrim Live Map is probably running already (check the taskbar). Open http://localhost:${HTTP_PORT}`
    : `[http] ${err.message}. Set HTTP_PORT to use another port.`);
  process.exit(1);
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log(`\nSkyrim Live Map running:`);
  console.log(`  This PC:      http://localhost:${HTTP_PORT}`);
  for (const a of addrs) console.log(`  Other device: http://${a.address}:${HTTP_PORT}  (${a.name})`);
  console.log(`  Maps:         ${dataDir}`);
  const best = addrs.find((a) => !VIRTUAL_ADAPTER.test(a.name));
  if (best) {
    console.log(`\nScan with your phone (same Wi-Fi network): http://${best.address}:${HTTP_PORT}`);
    qrcode.generate(`http://${best.address}:${HTTP_PORT}`, { small: true });
  }
});
