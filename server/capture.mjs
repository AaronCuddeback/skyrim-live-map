// Diagnostic: connect to the running relay as a viewer and summarize what the game
// sends for a few seconds. Read-only.  node capture.mjs [seconds]
import { WebSocket } from 'ws';

const seconds = Number(process.argv[2] ?? 6);
const ws = new WebSocket(`ws://localhost:${process.env.HTTP_PORT ?? 8787}/live`);
const counts = {};
let lastState = null;
const actorBatches = [];
let lastQuests = null;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  counts[msg.t] = (counts[msg.t] ?? 0) + 1;
  if (msg.t === 'state') lastState = msg;
  if (msg.t === 'actors') actorBatches.push(msg);
  if (msg.t === 'quests') lastQuests = msg;
  if (msg.actors && msg.t === 'state') actorBatches.push({ embedded: true, actors: msg.actors });
});

setTimeout(() => {
  ws.close();
  const s = lastState ?? {};
  console.log('packets by type:', counts);
  console.log('player:', { interior: s.interior, ws: s.ws, wsParent: s.wsParent, cell: s.cell, location: s.location, x: s.x, y: s.y });
  console.log('actor batches:', actorBatches.length, actorBatches.slice(-4).map((b) => `seq ${b.seq} part ${b.part}/${b.parts}: ${b.actors.length} actors`));
  const latest = actorBatches.at(-1)?.actors ?? [];
  console.log('sample actors:', latest.slice(0, 6).map((a) => `${a.name || '(no name)'} [${a.state}] lvl ${a.lvl} at ${Math.round(a.x)},${Math.round(a.y)} dist ${Math.round(Math.hypot(a.x - s.x, a.y - s.y))}`));
  console.log('quests:', lastQuests?.quests?.map((q) => `${q.name} (${q.targets.length} targets)`));
}, seconds * 1000);
