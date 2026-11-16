// The path you've walked, drawn on the map and remembered per map and per character.
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { toScene } from './world.js';

const MIN_STEP = 350;     // units (~5 m) between recorded points
const JUMP = 6000;        // a bigger move between updates is fast travel / a door: new segment
const MAX_POINTS = 6000;  // oldest points are dropped beyond this
const LIFT = 60;          // draw slightly above the ground

export function createTrail(scene, mapId) {
  // Line2 draws real pixel-width lines (WebGL lines are always 1px, too thin on a phone).
  const material = new LineMaterial({ color: 0xf3d58a, linewidth: 3, transparent: true, opacity: 0.75, depthTest: false });
  material.resolution.set(innerWidth, innerHeight);

  let key = null;
  let segments = []; // [[ [x, y, z], ... ], ...] in Skyrim units
  let lines = [];
  let dirty = false;
  let visible = true;

  function lineFor(segment) {
    if (segment.length < 2) return null;
    const positions = [];
    for (const [x, y, z] of segment) {
      const p = toScene(x, y, z + LIFT);
      positions.push(p.x, p.y, p.z);
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, material);
    line.renderOrder = 7;
    line.visible = visible;
    line.computeLineDistances();
    scene.add(line);
    return line;
  }

  function dispose(line) {
    if (!line) return;
    scene.remove(line);
    line.geometry.dispose();
  }

  function rebuildAll() {
    lines.forEach(dispose);
    lines = segments.map(lineFor);
  }

  function rebuildLast() {
    dispose(lines[segments.length - 1]);
    lines[segments.length - 1] = lineFor(segments.at(-1));
  }

  function save() {
    if (!dirty || !key) return;
    try { localStorage.setItem(key, JSON.stringify(segments)); } catch { /* storage full or unavailable */ }
    dirty = false;
  }
  setInterval(save, 10000);
  addEventListener('pagehide', save);

  function load(owner) {
    save();
    key = `slm-trail:${mapId}:${owner}`;
    try { segments = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { segments = []; }
    rebuildAll();
  }
  load('default');

  return {
    // Trails are per character: switch when the player packet names who's playing.
    setOwner(name) {
      const next = `slm-trail:${mapId}:${name || 'default'}`;
      if (next !== key) load(name || 'default');
    },

    add(x, y, z) {
      const segment = segments.at(-1);
      const last = segment?.at(-1);
      if (last) {
        const step = Math.hypot(x - last[0], y - last[1]);
        if (step < MIN_STEP) return;
        if (step > JUMP) segments.push([]);
      } else if (!segment) {
        segments.push([]);
      }
      segments.at(-1).push([Math.round(x), Math.round(y), Math.round(z)]);
      dirty = true;

      const total = segments.reduce((n, s) => n + s.length, 0);
      if (total > MAX_POINTS + 500) {
        let drop = total - MAX_POINTS;
        while (drop > 0 && segments.length) {
          const cut = Math.min(drop, segments[0].length);
          segments[0].splice(0, cut);
          drop -= cut;
          if (!segments[0].length) segments.shift();
        }
        rebuildAll();
      } else {
        rebuildLast();
      }
    },

    clear() {
      segments = [];
      dirty = true;
      save();
      rebuildAll();
    },

    setVisible(on) {
      visible = on;
      lines.forEach((line) => { if (line) line.visible = on; });
    },

    setResolution(width, height) {
      material.resolution.set(width, height);
    },

    get points() {
      return segments.reduce((n, s) => n + s.length, 0);
    },
  };
}
