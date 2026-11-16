// Diagnostic: replay a recording from record.mjs into a relay over UDP, with the
// original timing, as if the game were running.  node replay.mjs <recording.jsonl>
import dgram from 'node:dgram';
import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const port = Number(process.env.UDP_PORT ?? 27015);
const socket = dgram.createSocket('udp4');
const started = Date.now();
let i = 0;

(function next() {
  if (i >= lines.length) {
    console.log(`replayed ${lines.length} packets`);
    socket.close();
    return;
  }
  const tab = lines[i].indexOf('\t');
  const at = Number(lines[i].slice(0, tab));
  const wait = at - (Date.now() - started);
  if (wait > 0) return setTimeout(next, wait);
  socket.send(lines[i].slice(tab + 1), port, '127.0.0.1');
  i++;
  next();
})();
console.log(`replaying ${lines.length} packets to udp://127.0.0.1:${port}`);
