// Map location markers (cities, dungeons, camps...) rendered as DOM labels in 3D space.
import { Vector3 } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { toScene } from './world.js';

export const GROUPS = {
  city: { label: 'Cities & towns', glyph: '♜' },
  dungeon: { label: 'Dungeons', glyph: '✠' },
  camp: { label: 'Camps', glyph: '▲' },
  nature: { label: 'Landmarks', glyph: '✦' },
};

const KIND_GROUP = {
  Capital: 'city', City: 'city', Town: 'city', Settlement: 'city', Farm: 'city', 'Wheat Farm': 'city',
  Stable: 'city', 'Wood Mill': 'city', Smelter: 'city', Docks: 'city', Lighthouse: 'city', 'Orc Stronghold': 'city',
  Cave: 'dungeon', 'Nordic Ruin': 'dungeon', 'Dwemer Ruin': 'dungeon', Fort: 'dungeon', Mine: 'dungeon',
  Shipwreck: 'dungeon', Tower: 'dungeon', 'Nordic Tower': 'dungeon', 'Dragon Lair': 'dungeon',
  Camp: 'camp', 'Giant Camp': 'camp', 'Imperial Camp': 'camp', 'Stormcloak Camp': 'camp', Shack: 'camp',
  'Nordic Dwelling': 'camp',
};

// How far away (scene units) each kind of marker stays labelled.
const LABEL_RANGE = { Capital: Infinity, Town: 160, Settlement: 90, 'Orc Stronghold': 110 };

// Who wins when icons would overlap on screen: lower rank is placed first.
const KIND_RANK = { Capital: 0, City: 1, Town: 1, Settlement: 2, 'Orc Stronghold': 2 };
const GROUP_RANK = { city: 3, dungeon: 4, camp: 5, nature: 6 };

export function createMarkers(scene, markers, heightAt, { touch = false } = {}) {
  const items = markers.map((m) => {
    const group = KIND_GROUP[m.kind] ?? 'nature';
    const el = document.createElement('div');
    el.className = `mk g-${m.kind === 'Capital' ? 'city' : group}`;
    if (m.kind !== 'Capital' && group === 'city') el.classList.replace('g-city', 'g-town');
    el.innerHTML = `<span class="ico">${GROUPS[group].glyph}</span><span class="lbl"></span>`;
    const ico = el.firstChild, lbl = el.lastChild;
    lbl.textContent = m.name;

    const obj = new CSS2DObject(el);
    obj.center.set(0, 0.5);
    // Markers inside walled cities sit on top of the city mesh, not the terrain under it.
    const z = Math.max(m.z, heightAt(m.x, m.y)) + 300;
    toScene(m.x, m.y, z, obj.position);
    scene.add(obj);
    const capital = m.kind === 'Capital';
    return {
      m, el, ico, lbl, obj, group,
      rank: KIND_RANK[m.kind] ?? GROUP_RANK[group],
      labelRange: LABEL_RANGE[m.kind] ?? 45,
      iconRange: capital ? Infinity : group === 'city' ? 420 : 260,
      iconHalf: capital ? 13 : 10,
      // Rough rendered label width; only used to keep labels from overlapping.
      labelWidth: m.name.length * (capital ? 9.5 : 6.6),
    };
  });

  // Fixed placement order (rank, base game before mods, then file order) so the
  // same markers win frame after frame instead of flickering as the camera moves.
  const ordered = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.rank - b.it.rank || Boolean(a.it.m.source) - Boolean(b.it.m.source) || a.i - b.i)
    .map(({ it }) => it);
  const spacing = touch ? 28 : 21; // minimum px between icon centers
  let pinned = null;               // a searched/tapped marker that always shows
  let discovery = null;            // id -> 'discovered' | 'known'; null = no data, show all
  let showUndiscovered = false;
  const v = new Vector3();

  // Undiscovered places are hidden unless asked for; ones you've only heard of (or
  // undiscovered ones shown on request) are drawn faded.
  function setDiscovery(map, showAll) {
    discovery = map;
    showUndiscovered = showAll;
    for (const it of items) {
      const state = discovery ? discovery.get(it.m.id) ?? 'undiscovered' : 'discovered';
      it.hiddenByDiscovery = state === 'undiscovered' && !showUndiscovered;
      it.el.classList.toggle('mk-faded', state !== 'discovered');
    }
  }

  // Markers don't take pointer events (so they never block pinch/pan on the map);
  // a tap is matched to the nearest visible icon, or a label it lands on.
  function pick(x, y, radius) {
    let best = null, bestDist = radius;
    for (const it of items) {
      if (!it.obj.visible || it.el.style.display === 'none') continue;
      const r = it.ico.getBoundingClientRect();
      let dist = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (dist > bestDist && it.el.classList.contains('show-label')) {
        const l = it.lbl.getBoundingClientRect();
        if (x >= l.left && x <= l.right && y >= l.top && y <= l.bottom) dist = bestDist - 0.01;
      }
      if (dist < bestDist) {
        best = it;
        bestDist = dist;
      }
    }
    return best && { m: best.m, el: best.el };
  }

  const enabled = new Set(Object.keys(GROUPS));

  // Place icons in priority order, skipping any that would land on one already
  // placed; labels get the same treatment. Zooming in spreads markers apart, so
  // hidden ones reappear.
  function update(camera) {
    const w = innerWidth, h = innerHeight;
    const grid = new Map();
    const labelBoxes = [];
    const crowded = (x, y) => {
      const gx = Math.floor(x / spacing), gy = Math.floor(y / spacing);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const [px, py] of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (Math.abs(px - x) < spacing && Math.abs(py - y) < spacing) return true;
          }
        }
      }
      // Placed labels claim their space too, so icons don't cover a town's name.
      return labelBoxes.some((b) => x > b[0] - spacing / 2 && x < b[2] + spacing / 2 && y > b[1] - spacing / 2 && y < b[3] + spacing / 2);
    };

    for (const it of pinned ? [pinned, ...ordered] : ordered) {
      if (it === pinned && it.placed) continue;
      it.placed = false;
      const d = camera.position.distanceTo(it.obj.position);
      let on = it === pinned || (enabled.has(it.group) && d < it.iconRange && !it.hiddenByDiscovery);
      let x = 0, y = 0;
      if (on) {
        v.copy(it.obj.position).project(camera);
        x = (v.x + 1) / 2 * w + it.iconHalf;
        y = (1 - v.y) / 2 * h;
        const onScreen = v.z < 1 && x > -40 && x < w + 40 && y > -40 && y < h + 40;
        on = onScreen && (it === pinned || !crowded(x, y));
      }
      it.obj.visible = on;
      if (!on) continue;
      it.placed = true;
      const key = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([x, y]);

      let label = d < it.labelRange || it === pinned;
      if (label) {
        const box = [x + it.iconHalf + 4, y - 9, x + it.iconHalf + 4 + it.labelWidth, y + 9];
        label = it === pinned || !labelBoxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (label) labelBoxes.push(box);
      }
      it.el.classList.toggle('show-label', label);
    }
    if (pinned) pinned.placed = false;
  }

  // Keep one marker visible and labelled regardless of crowding (search result, tapped icon).
  function focus(m) {
    pinned = items.find((it) => it.m === m) ?? null;
  }

  function setGroup(group, on) {
    if (on) enabled.add(group); else enabled.delete(group);
  }

  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((it) => it.m.name.toLowerCase().includes(q))
      .sort((a, b) => a.m.name.toLowerCase().indexOf(q) - b.m.name.toLowerCase().indexOf(q))
      .slice(0, 30)
      .map((it) => it.m);
  }

  return { update, setGroup, setDiscovery, search, pick, focus, enabled };
}
