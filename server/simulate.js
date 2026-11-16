// Fake game: sends the same UDP packets as the SKSE plugin so the map can be
// tested without Skyrim running. Walks Helgen -> Riverwood -> Whiterun -> ...
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.RELAY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.UDP_PORT ?? 27015);
const SPEED = Number(process.env.SPEED ?? 900); // units/s (a horse gallop is ~800)
const TAMRIEL = 0x3c;

// MAP=<dataset id> picks which extracted modlist to pretend to be playing.
const dataRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'data');
const datasets = JSON.parse(fs.readFileSync(path.join(dataRoot, 'datasets.json'), 'utf8'));
const dataset = datasets.find((d) => d.id === process.env.MAP) ?? datasets[0];
const dataDir = path.join(dataRoot, dataset.id);
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'terrain.json'), 'utf8'));
const markers = JSON.parse(fs.readFileSync(path.join(dataDir, 'markers.json'), 'utf8'));
const hbuf = fs.readFileSync(path.join(dataDir, meta.heightmap.file));
const heights = new Float32Array(hbuf.buffer, hbuf.byteOffset, hbuf.byteLength / 4);

function groundZ(x, y) {
  const { width: W, height: H, spacing } = meta.heightmap;
  const fx = Math.min(Math.max((x - meta.minCellX * meta.cellUnits) / spacing, 0), W - 1.001);
  const fy = Math.min(Math.max((y - meta.minCellY * meta.cellUnits) / spacing, 0), H - 1.001);
  const c = Math.floor(fx), r = Math.floor(fy), tx = fx - c, ty = fy - r;
  const h = (rr, cc) => heights[rr * W + cc];
  return (h(r, c) * (1 - tx) + h(r, c + 1) * tx) * (1 - ty) + (h(r + 1, c) * (1 - tx) + h(r + 1, c + 1) * tx) * ty;
}

const route = ['Helgen', 'Riverwood', 'Bleak Falls Barrow', 'Riverwood', 'Whiterun', 'Honningbrew Meadery', 'Whiterun']
  .map((name) => markers.find((m) => m.name === name))
  .filter(Boolean);
if (route.length < 2) throw new Error('Route markers not found; run tools/extract_map.py first');

const rand = (a, b) => a + Math.random() * (b - a);
let nextId = 0xff000100;
const actor = (name, race, state, lvl, radius) => ({ id: nextId++, name, race, state, lvl, hp: 1, radius, ang: rand(0, 6.28), ox: 0, oy: 0 });
const cast = [
  actor('Lydia', 'Nord', 'ally', 12, 250),
  actor('Wolf', 'Wolf', 'hostile', 6, 1400),
  actor('Wolf', 'Wolf', 'hostile', 6, 1600),
  actor('Bandit Outlaw', 'Redguard', 'hostile', 9, 2200),
  actor('Bandit', 'Nord', 'dead', 5, 900),
  actor('Whiterun Guard', 'Nord', 'neutral', 15, 1800),
  actor('Hunter', 'Bosmer', 'neutral', 8, 2600),
  actor('Elk', 'Elk', 'neutral', 3, 3000),
  actor('Mudcrab', 'Mudcrab', 'hostile', 2, 1200),
];
// A busy exterior in a big modlist: enough extra townsfolk to need several batches.
for (let i = 0; i < Number(process.env.CROWD ?? 50); i++) cast.push(actor(`Traveler ${i + 1}`, 'Nord', 'neutral', 5, rand(800, 4000)));
const ACTORS_PER_PACKET = 24;

const item = (n, k, c, w, v, extra = {}) => ({ n, k, c, w, v, d: 0, a: 0, e: 0, f: 0, x: 0, q: 0, ...extra });
const SAMPLE_ITEMS = [
  item('Steel Greatsword', 'weapon', 1, 20, 90, { d: 17, e: 1, f: 1 }),
  item('Hunting Bow', 'weapon', 1, 7, 50, { d: 7 }),
  item('Ebony Dagger of Burning', 'weapon', 1, 5, 450, { d: 10, x: 1 }),
  item('Steel Plate Armor', 'apparel', 1, 38, 625, { a: 40, e: 1 }),
  item('Steel Plate Helmet', 'apparel', 1, 7, 125, { a: 19, e: 1 }),
  item('Amulet of Talos', 'apparel', 1, 1, 25, { e: 1, x: 1 }),
  item('Potion of Minor Healing', 'potion', 6, 0.5, 17, { f: 1 }),
  item('Potion of Stamina', 'potion', 3, 0.5, 20),
  item('Weak Poison', 'poison', 2, 0.5, 20),
  item('Sweetroll', 'food', 2, 0.5, 2),
  item('Grilled Leeks', 'food', 1, 0.2, 6),
  item('Blue Mountain Flower', 'ingredient', 8, 0.1, 2),
  item('Wheat', 'ingredient', 4, 0.1, 5),
  item('Scroll of Fireball', 'scroll', 1, 0.5, 150),
  item('The Lusty Argonian Maid, v1', 'book', 1, 1, 15),
  item('Steel Arrow', 'ammo', 74, 0, 2, { d: 10, e: 1 }),
  item('Petty Soul Gem (Filled)', 'soulgem', 2, 0.1, 30),
  item("Hjerim Key", 'key', 1, 0, 0),
  item('Golden Claw', 'misc', 1, 0.25, 100, { q: 1 }),
  item('Lockpick', 'misc', 23, 0, 3),
  item('Iron Ingot', 'misc', 5, 1, 7),
];
const spell = (n, k, c, fx, eq = '') => ({ n, k, c, fx, eq });
const SAMPLE_SPELLS = [
  spell('Flames', 'destruction', 14, 'Fire Damage · 8 pts', 'left'),
  spell('Firebolt', 'destruction', 41, 'Fire Damage · 25 pts'),
  spell('Healing', 'restoration', 12, 'Restore Health · 10 pts', 'right'),
  spell('Oakflesh', 'alteration', 87, 'Armor Bonus · 40 pts · 60 s'),
  spell('Candlelight', 'alteration', 21, 'Light · 60 s'),
  spell('Conjure Familiar', 'conjuration', 48, 'Summon Spectral Wolf · 60 s'),
  spell('Clairvoyance', 'illusion', 21, 'Clairvoyance · 1 s'),
  spell('Battle Cry', 'power', 0, 'Fear · 25 pts · 30 s'),
  spell('Unrelenting Force', 'shout', 0, '', 'power'),
  spell('Whirlwind Sprint', 'shout', 0, ''),
];

// The dungeon the simulator visits: Bleak Falls Temple, by its real cell key from this
// map's local map index, starting at its entrance door (from the built local map, if any).
const TAMRIEL_KEY = 'skyrim.esm:00003C';
const DUNGEON = 'Bleak Falls Temple';
let dungeonKey = '';
let dungeonStart = { x: 0, y: 0, z: 0 };
try {
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'localindex.json'), 'utf8'));
  dungeonKey = Object.entries(index.interiors).find(([, v]) => v.name === DUNGEON)?.[0] ?? '';
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'local', `i_${dungeonKey.replace(':', '_')}.json`), 'utf8'));
  const [x, y, z] = meta.doors[0];
  dungeonStart = { x, y, z };
} catch { /* no index yet, or not built yet: the map builds it on first visit */ }
let inner = { ...dungeonStart };

const socket = dgram.createSocket('udp4');
let leg = 0, t = 0, tick = 0;
let pos = { x: route[0].x, y: route[0].y };
let heading = 0;
let interiorUntil = 0;
const started = Date.now();

function step(dt) {
  const a = route[leg], b = route[(leg + 1) % route.length];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  t += (SPEED * dt) / len;
  if (t >= 1) { t = 0; leg = (leg + 1) % route.length; }
  // A little sideways wander so the trail isn't a ruler line.
  const wob = Math.sin(Date.now() / 3000) * 400;
  const nx = a.x + dx * t + (-dy / len) * wob, ny = a.y + dy * t + (dx / len) * wob;
  heading = Math.atan2(nx - pos.x, ny - pos.y);
  pos = { x: nx, y: ny };
}

setInterval(() => {
  const now = Date.now();
  const elapsed = (now - started) / 1000;
  // Every ~70 s, spend 15 s "inside" a dungeon.
  if (!interiorUntil && (elapsed % 70 > 55 || (process.env.START_INSIDE && elapsed < 1))) {
    interiorUntil = now + Number(process.env.INSIDE_SECONDS ?? 15) * 1000;
    inner = { ...dungeonStart };
  }
  const inside = interiorUntil > now;
  if (interiorUntil && !inside) interiorUntil = 0;
  if (!inside) step(0.1);
  else {
    // Walk slowly into the dungeon from its entrance.
    heading = Math.PI / 2 + Math.sin(elapsed / 4) * 0.4;
    inner = { x: inner.x + Math.sin(heading) * 25, y: inner.y + Math.cos(heading) * 25, z: inner.z };
  }
  const here = inside ? inner : pos;

  const z = inside ? inner.z : groundZ(pos.x, pos.y);
  const nearest = markers.reduce((best, m) => {
    const d = Math.hypot(m.x - pos.x, m.y - pos.y);
    return d < best.d ? { m, d } : best;
  }, { m: null, d: Infinity });

  const state = {
    t: 'state', x: here.x, y: here.y, z, h: heading, interior: inside,
    ws: inside ? 0 : TAMRIEL, wsParent: 0, lvl: 14, hp: 0.6 + 0.4 * Math.abs(Math.sin(elapsed / 9)),
    combat: cast.some((c) => c.state === 'hostile' && c.radius < 900), mounted: !inside && SPEED > 500,
    cell: inside ? DUNGEON : '',
    location: inside ? 'Bleak Falls Barrow' : nearest.d < 6000 ? nearest.m.name : '',
    game: dataset.gamePath.replace(/\//g, '\\'),
    cellKey: inside ? dungeonKey : '',
    wsKey: inside ? '' : TAMRIEL_KEY,
  };

  let actorList = null;
  if (tick++ % 5 === 0) {
    actorList = cast.map((c) => {
      if (c.state !== 'dead') c.ang += rand(-0.15, 0.25);
      if (c.state === 'hostile') c.radius = Math.max(350, c.radius - rand(0, 60)); // close in
      const ax = here.x + Math.cos(c.ang) * c.radius, ay = here.y + Math.sin(c.ang) * c.radius;
      c.hp = c.state === 'dead' ? 0 : Math.max(0.1, c.hp - (c.radius < 600 ? 0.03 : 0));
      return {
        id: c.id, x: ax, y: ay, z: inside ? inner.z + rand(-50, 50) : groundZ(ax, ay), h: c.ang, lvl: c.lvl,
        hp: c.hp, combat: c.state === 'hostile', npc: c.race !== 'Wolf' && c.race !== 'Elk' && c.race !== 'Mudcrab',
        state: c.state, name: c.name, race: c.race,
      };
    });
    // Respawn hostiles that "died" up close so the demo keeps going.
    for (const c of cast) if (c.state === 'hostile' && c.hp <= 0.1) { c.radius = rand(1500, 2500); c.hp = 1; }
  }

  socket.send(JSON.stringify(state), PORT, HOST);
  if (actorList) {
    // Same batching as the plugin: numbered packets of up to 24 actors.
    const seq = tick;
    const parts = Math.max(1, Math.ceil(actorList.length / ACTORS_PER_PACKET));
    for (let part = 0; part < parts; part++) {
      const batch = actorList.slice(part * ACTORS_PER_PACKET, (part + 1) * ACTORS_PER_PACKET);
      socket.send(JSON.stringify({ t: 'actors', seq, part, parts, actors: batch }), PORT, HOST);
    }
  }
  if (tick % 10 === 1) {
    // Tracked quests, like the plugin's quest packet: one target indoors (pinned at the
    // dungeon's map marker), one outdoors.
    const bleak = markers.find((m) => m.name === 'Bleak Falls Barrow');
    const whiterun = markers.find((m) => m.name === 'Whiterun');
    const quests = [
      { id: 0x0001b07f, name: 'The Golden Claw', objectives: ['Retrieve the Golden Claw'],
        targets: bleak ? [{ x: bleak.x, y: bleak.y, z: bleak.z, text: 'Retrieve the Golden Claw', inside: 'Bleak Falls Barrow' }] : [] },
      { id: 0x0002610c, name: 'Before the Storm', objectives: ['Deliver news to Jarl Balgruuf'],
        targets: whiterun ? [{ x: whiterun.x + 1500, y: whiterun.y + 2500, z: whiterun.z + 600, text: 'Deliver news to Jarl Balgruuf', inside: '' }] : [] },
    ];
    socket.send(JSON.stringify({ t: 'quests', quests }), PORT, HOST);
    // Character stats, like the plugin's player packet.
    const hp = Math.round(state.hp * 340);
    socket.send(JSON.stringify({
      t: 'player', name: 'Dovahkiin', race: 'Nord', lvl: 14, xp: (elapsed / 300) % 1, perks: 2,
      hp: [hp, 340], mp: [Math.round(160 + 60 * Math.sin(elapsed / 4)), 220], sp: [Math.round(200 + 80 * Math.cos(elapsed / 3)), 280],
      gold: 1873, carry: [212, 330], souls: 3, sneak: elapsed % 40 > 30, drawn: state.combat, combat: state.combat, mounted: state.mounted,
      right: 'Steel Greatsword', left: 'Steel Greatsword', time: 'Morndas, 9:41 AM, 17th of Last Seed, 4E 201',
    }), PORT, HOST);
  }
  if (tick % 50 === 7) {
    // Every 5 s, like the plugin: discovered places, inventory and magic, in batches.
    const batches = (type, field, entries, per) => {
      const parts = Math.max(1, Math.ceil(entries.length / per));
      for (let part = 0; part < parts; part++) {
        socket.send(JSON.stringify({ t: type, seq: tick, part, parts, [field]: entries.slice(part * per, (part + 1) * per) }), PORT, HOST);
      }
    };
    const discovered = markers.filter((m, i) => i % 2 === 0 || ['Helgen', 'Riverwood', 'Whiterun', 'Bleak Falls Barrow'].includes(m.name)).map((m) => m.id);
    const known = markers.filter((m, i) => i % 7 === 1).map((m) => m.id);
    const ids = [...discovered.map((id) => ['d', id]), ...known.map((id) => ['k', id])];
    const parts = Math.max(1, Math.ceil(ids.length / 150));
    for (let part = 0; part < parts; part++) {
      const slice = ids.slice(part * 150, (part + 1) * 150);
      socket.send(JSON.stringify({ t: 'discovered', seq: tick, part, parts, discovered: slice.filter(([s]) => s === 'd').map(([, id]) => id), known: slice.filter(([s]) => s === 'k').map(([, id]) => id) }), PORT, HOST);
    }
    batches('inventory', 'items', SAMPLE_ITEMS, 40);
    batches('magic', 'spells', SAMPLE_SPELLS, 40);
  }
  if (tick % 50 === 0) {
    console.log(`${inside ? '[interior]' : '[outside] '} ${state.location || 'wilderness'}  (${Math.round(pos.x)}, ${Math.round(pos.y)})`);
  }
}, 100);

console.log(`Pretending to play: ${dataset.name} (MAP=${dataset.id})`);
console.log(`Simulating player along: ${route.map((m) => m.name).join(' -> ')}`);
console.log(`Sending to udp://${HOST}:${PORT}`);
