// Diagnostic: record everything the relay broadcasts to a file, for replaying later
// with replay.mjs.  node record.mjs <seconds> <out.jsonl>
import fs from 'node:fs';
import { WebSocket } from 'ws';

const seconds = Number(process.argv[2] ?? 60);
const out = fs.createWriteStream(process.argv[3] ?? 'recording.jsonl');
const ws = new WebSocket(`ws://localhost:${process.env.HTTP_PORT ?? 8787}/live`);
const started = Date.now();
const counts = {};
ws.on('message', (data) => {
  const text = data.toString();
  const type = JSON.parse(text).t;
  counts[type] = (counts[type] ?? 0) + 1;
  out.write(`${Date.now() - started}\t${text}\n`);
});
setTimeout(() => {
  ws.close();
  out.end();
  console.log(`recorded ${seconds}s:`, counts);
}, seconds * 1000);
