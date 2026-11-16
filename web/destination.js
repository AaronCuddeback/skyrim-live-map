// A destination you pick on the map: pin, dashed line from the player, and a chip with
// distance, ETA (from your actual recent speed) and a turn arrow. Remembered per map.
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { METERS_PER_UNIT, toScene } from './world.js';

const ARRIVED = 1200;     // units (~17 m)
const SPEED_WINDOW = 8;   // seconds of movement used for the speed estimate
const LIFT = 120;

export function formatMeters(units) {
  const m = units * METERS_PER_UNIT;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function createDestination({ scene, pinScene, mapId, chip, onArrive }) {
  const key = `slm-destination:${mapId}`;
  const material = new LineMaterial({ color: 0x7fd3ff, linewidth: 2.5, dashed: true, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.9, depthTest: false });
  material.resolution.set(innerWidth, innerHeight);
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 0, 0, 0]);
  const line = new Line2(geometry, material);
  line.renderOrder = 8;
  line.visible = false;
  scene.add(line);

  const el = document.createElement('div');
  el.className = 'dp';
  el.innerHTML = '<span class="dpico">⚑</span><span class="dplbl"></span>';
  const pin = new CSS2DObject(el);
  pin.center.set(0.5, 1);
  pin.visible = false;
  pinScene.add(pin);

  let target = null; // { name, x, y, z }
  const samples = []; // { t, x, y } recent player positions
  let arrivedAt = 0;

  function persist() {
    try {
      if (target) localStorage.setItem(key, JSON.stringify(target));
      else localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
  }

  function set(next) {
    target = next;
    arrivedAt = 0;
    persist();
    pin.visible = Boolean(target);
    chip.root.hidden = !target;
    line.visible = false;
    if (target) {
      el.lastChild.textContent = target.name;
      toScene(target.x, target.y, target.z + LIFT, pin.position);
      chip.name.textContent = target.name;
      chip.info.textContent = 'Waiting for your position…';
    }
  }

  try { const saved = JSON.parse(localStorage.getItem(key) ?? 'null'); if (saved) set(saved); } catch { /* ignore */ }

  // Average speed over the last few seconds of outdoor movement (units/s).
  function speed() {
    if (samples.length < 2) return 0;
    const a = samples[0], b = samples.at(-1);
    let dist = 0;
    for (let i = 1; i < samples.length; i++) dist += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    return b.t > a.t ? dist / (b.t - a.t) : 0;
  }

  return {
    set,
    clear: () => set(null),
    get target() { return target; },

    // Called with each outdoor player state.
    update(s) {
      const now = performance.now() / 1000;
      const last = samples.at(-1);
      // A teleport (fast travel, door) isn't travel speed: start over.
      if (last && Math.hypot(s.x - last.x, s.y - last.y) > 6000) samples.length = 0;
      samples.push({ t: now, x: s.x, y: s.y });
      while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW) samples.shift();
      if (!target) return;

      const dx = target.x - s.x, dy = target.y - s.y;
      const dist = Math.hypot(dx, dy);
      const from = toScene(s.x, s.y, s.z + LIFT), to = toScene(target.x, target.y, target.z + LIFT);
      geometry.setPositions([from.x, from.y, from.z, to.x, to.y, to.z]);
      line.computeLineDistances();
      line.visible = true;

      // Bearing clockwise from north, relative to where the character faces.
      const bearing = Math.atan2(dx, dy);
      chip.arrow.style.transform = `rotate(${bearing - s.h}rad)`;

      if (dist < ARRIVED) {
        if (!arrivedAt) {
          arrivedAt = now;
          chip.info.textContent = 'You have arrived';
          onArrive?.(target);
        } else if (now - arrivedAt > 6) {
          set(null);
        }
        return;
      }
      const v = speed();
      const eta = v > 40 ? ` · ETA ${formatDuration(dist / v)}` : '';
      chip.info.textContent = `${formatMeters(dist)}${eta}`;
    },

    setResolution(width, height) {
      material.resolution.set(width, height);
    },
  };
}
