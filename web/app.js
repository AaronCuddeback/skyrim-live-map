import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createActors, createPlayer, distanceUnits } from './entities.js';
import { actorKind, DISPOSITIONS, iconURL } from './icons.js';
import { createMarkers, GROUPS } from './markers.js';
import { connectLive } from './live.js';
import { createQuestPins } from './quests.js';
import { createTrail } from './trail.js';
import { createDestination } from './destination.js';
import { createSheet } from './sheet.js';
import { createBuildings, createInteriorMap } from './localmap.js';
import { bearing, createCompass } from './compass.js';
import { createRemote } from './remote.js';
import { drawRadar } from './radar.js';
import { loadWorld, METERS_PER_UNIT, SCALE, STYLE_LOOK, toScene } from './world.js';

const TAMRIEL = 0x3c;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- settings
const prefs = (() => {
  const defaults = { groups: Object.keys(GROUPS), mobs: true, panel: false, style: 'terrain', mapMode: 'auto', lastMap: null };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('slm-prefs') ?? '{}') }; } catch { return defaults; }
})();
function savePrefs() {
  try { localStorage.setItem('slm-prefs', JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- scene
const container = $('map');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
container.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
container.appendChild(labels.domElement);

// Quest pins get their own scene and label layer, stacked above location markers.
const questLabels = new CSS2DRenderer();
questLabels.setSize(innerWidth, innerHeight);
Object.assign(questLabels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
container.appendChild(questLabels.domElement);
const questScene = new THREE.Scene();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15191f);
scene.fog = new THREE.Fog(0x15191f, 700, 1900);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 4000);
// Relief is already baked into the textures, so keep lighting mostly ambient.
const ambient = new THREE.HemisphereLight(0xf2f5f8, 0x6b6050, 2.6);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
sun.position.set(-1, 1.4, -0.8);
scene.add(sun);

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 1100;
controls.maxPolarAngle = 1.3;
// Touch: one finger pans, two fingers pinch-zoom (and pan). Rotation is our own
// twist gesture below, so a pinch never accidentally spins or tilts the map.
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
  questLabels.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- which map (modlist)
// Each modlist / setup has its own extracted map. "Auto" follows the game folder the
// SKSE plugin reports; picking one pins it.
const datasets = await fetch('data/datasets.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
if (!datasets.length) await waitForFirstMap();

// First run: no map exists until the game connects and the relay builds one for it.
function waitForFirstMap() {
  const [title, detail] = [$('loading').children[1], $('loading-detail')];
  const show = (head, text) => { title.textContent = head; detail.textContent = text; };
  show('Waiting for Skyrim', 'Start the game the way you always do (through your mod manager, with SKSE). '
    + 'The first time, the map for your modlist is built from your own game files, which takes a minute or two.');
  let sawBuild = false;
  const reloadIfMapped = () => fetch('data/datasets.json', { cache: 'no-cache' }).then((r) => r.json())
    .then((list) => { if (list.length) location.reload(); }).catch(() => {});
  connectLive({
    onOpen: reloadIfMapped, // e.g. the relay restarted after building one
    onClose: () => show('Relay offline', 'Start Skyrim Live Map on the gaming PC, then reload this page.'),
    onState: () => { if (!sawBuild) show('Game connected', 'Getting ready to build the map…'); },
    onBuild: (msg) => {
      if (msg.state === 'running') {
        sawBuild = true;
        show('Building your map', `${msg.line}\nThis takes a minute or two, once per modlist.`);
      } else if (msg.state === 'done') {
        reloadIfMapped(); // the relay replays its last build on connect, so check it made one
      } else if (msg.state === 'failed') {
        sawBuild = true;
        show("Couldn't build the map", `${msg.error}\nThe Skyrim Live Map window on the gaming PC has the details.`);
      }
    },
  });
  return new Promise(() => {}); // the page reloads once there's a map
}
const normPath = (p) => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const requested = new URLSearchParams(location.search).get('map');
const dataset = datasets.find((d) => d.id === requested)
  ?? datasets.find((d) => d.id === (prefs.mapMode === 'auto' ? prefs.lastMap : prefs.mapMode))
  ?? datasets[0];
const base = `data/${dataset.id}/`;

function openMap(id) {
  const url = new URL(location.href);
  url.searchParams.set('map', id);
  location.replace(url);
}

// ---------------------------------------------------------------- world
const world = await loadWorld(renderer, { base, decimate: isTouch ? 2 : 1, style: prefs.style });
scene.add(world.terrain, world.water);

function applyLook(id, look) {
  scene.background.set(look.background);
  scene.fog.color.set(look.background);
  ambient.intensity = look.ambient;
  sun.intensity = look.sun;
  document.body.dataset.style = id;
}
applyLook(world.style, STYLE_LOOK[world.style] ?? STYLE_LOOK.terrain);

async function setStyle(id) {
  const { style, look } = await world.setStyle(id);
  applyLook(style.id, look);
  buildings.setColor(look.buildings);
  prefs.style = style.id;
  savePrefs();
  for (const b of document.querySelectorAll('#styles button')) b.setAttribute('aria-pressed', String(b.dataset.id === style.id));
}

const markerData = await fetch(`${base}markers.json`).then((r) => r.json());
const popup = document.createElement('div');
popup.className = 'mk-popup';
popup.hidden = true;
document.body.appendChild(popup);

const markers = createMarkers(scene, markerData, world.heightAt, { touch: isTouch });
for (const g of Object.keys(GROUPS)) markers.setGroup(g, prefs.groups.includes(g));

const player = createPlayer(scene);
const actors = createActors(scene);
const questPins = createQuestPins(questScene);
const trail = createTrail(scene, dataset.id);
trail.setVisible(prefs.trail !== false);
const destination = createDestination({
  scene,
  pinScene: questScene,
  mapId: dataset.id,
  chip: { root: $('dest'), name: $('dest-name'), info: $('dest-info'), arrow: $('dest-arrow') },
});
addEventListener('resize', () => {
  trail.setResolution(innerWidth, innerHeight);
  destination.setResolution(innerWidth, innerHeight);
});
// Interior floor plans (radar as the fallback) and buildings around you outdoors.
const interiorMap = createInteriorMap({
  container: $('imap'),
  status: $('imap-status'),
  mapId: dataset.id,
  onState: (state) => {
    $('interior').classList.toggle('has-map', state === 'ready');
    $('interior').classList.toggle('map-loading', state === 'loading');
  },
});
$('imap-in').onclick = () => interiorMap.zoom(1 / 1.3);
$('imap-out').onclick = () => interiorMap.zoom(1.3);
const compass = createCompass($('compass-canvas'));
const buildings = createBuildings(scene, dataset.id);
buildings.setColor((STYLE_LOOK[world.style] ?? STYLE_LOOK.terrain).buildings);

const sheet = createSheet({
  root: $('sheet'), list: $('sheet-list'), cats: $('sheet-cats'), summary: $('sheet-summary'),
  search: $('sheet-search'), sort: $('sheet-sort'), tabs: [...document.querySelectorAll('.sheet-tabs button')],
});
$('open-inventory').onclick = () => sheet.open('inventory');
$('open-magic').onclick = () => sheet.open('magic');
$('sheet-close').onclick = () => sheet.close();
addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.close(); });
$('dest-clear').onclick = (e) => {
  e.stopPropagation();
  destination.clear();
};
$('dest').onclick = () => {
  const t = destination.target;
  if (!t) return;
  setFollow(false);
  flyTo(toScene(t.x, t.y, t.z));
};

// Start in 2D, looking straight down from close range, north up. The view snaps onto
// the player when the first position arrives; zoom out freely from there.
const START_DISTANCE = 36; // scene units (~480 m of map top to bottom)
const home = markerData.find((m) => m.name === 'Whiterun') ?? { x: 0, y: 0, z: 0 };
toScene(home.x, home.y, home.z, controls.target);
controls.maxPolarAngle = 0.001;
camera.position.copy(controls.target).add(new THREE.Vector3(0, START_DISTANCE, 0.15));
controls.update();
$('loading').classList.add('done');
setTimeout(() => $('loading').remove(), 800);

// ---------------------------------------------------------------- camera helpers
// Every page load starts following the player; panning turns it off for this visit only.
let follow = true;
let topDown = true;
let snappedToPlayer = false;
let flight = null;

function setFollow(on) {
  follow = on;
  $('btn-follow').setAttribute('aria-pressed', String(on));
  // While following, zoom toward the player; zooming toward the cursor would fight the follow-cam.
  controls.zoomToCursor = !on;
}
setFollow(follow);

function flyTo(pos, distance = null) {
  const offset = camera.position.clone().sub(controls.target);
  if (distance) offset.setLength(distance);
  flight = { t: 0, fromT: controls.target.clone(), toT: pos.clone(), fromC: camera.position.clone(), toC: pos.clone().add(offset) };
}

function setPolar(phi) {
  const offset = camera.position.clone().sub(controls.target);
  const s = new THREE.Spherical().setFromVector3(offset);
  s.phi = phi;
  flight = { t: 0, fromT: controls.target.clone(), toT: controls.target.clone(), fromC: camera.position.clone(), toC: controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)) };
}

$('btn-follow').onclick = () => {
  setFollow(!follow);
  if (follow && player.hasFix) flyTo(player.object.position);
};
$('btn-view').onclick = () => {
  topDown = !topDown;
  $('view-label').textContent = topDown ? '3D' : '2D';
  controls.maxPolarAngle = topDown ? 0.001 : 1.3;
  controls.minPolarAngle = 0;
  setPolar(topDown ? 0.001 : 0.85);
};
$('btn-style').onclick = () => {
  const ids = world.styles.map((s) => s.id);
  setStyle(ids[(ids.indexOf(world.style) + 1) % ids.length]);
};
$('btn-north').onclick = () => {
  const offset = camera.position.clone().sub(controls.target);
  const s = new THREE.Spherical().setFromVector3(offset);
  s.theta = 0;
  flight = { t: 0, fromT: controls.target.clone(), toT: controls.target.clone(), fromC: camera.position.clone(), toC: controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)) };
};

// ---------------------------------------------------------------- in-game hotkeys
// Zoom acts on the interior floor plan while it's showing, otherwise on the world map.
// Panning moves along the screen's axes, like dragging, and stops following the player.
const remote = createRemote({
  zoom(factor) {
    if (lastState?.interior && interiorMap.ready) {
      interiorMap.zoom(factor);
      return;
    }
    flight = null;
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.min(Math.max(offset.length() * factor, controls.minDistance), controls.maxDistance));
    camera.position.copy(controls.target).add(offset);
  },
  pan(x, y, dt) {
    if (lastState?.interior && interiorMap.ready) return;
    if (follow) setFollow(false);
    flight = null;
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).setY(0);
    if (up.lengthSq() < 1e-6) up.setFromMatrixColumn(camera.matrixWorld, 2).negate().setY(0);
    up.normalize();
    const speed = camera.position.distanceTo(controls.target) * 0.9 * dt;
    const move = right.multiplyScalar(x * speed).addScaledVector(up, y * speed);
    controls.target.add(move);
    camera.position.add(move);
  },
  follow() {
    setFollow(true);
    if (player.hasFix) flyTo(player.object.position);
  },
  view: () => $('btn-view').click(),
  style: () => $('btn-style').click(),
});

// ---------------------------------------------------------------- gestures
// One finger / left drag pans and takes the camera off the player. Two fingers
// pinch-zoom; twisting them rotates once the twist is clearly deliberate. A quick
// tap selects the nearest location marker.
const canvas = renderer.domElement;
const pointers = new Map();
const TWIST_THRESHOLD = 0.2; // radians (~11°) of twist before rotation kicks in
let twist = null;
let multiTouch = false;

function fingerAngle() {
  const [a, b] = [...pointers.values()];
  return Math.atan2(b.cy - a.cy, b.cx - a.cx);
}

// Long-press (or right-click) an empty spot to make it your destination.
const LONG_PRESS_MS = 550;
let longPressTimer = 0;
let longPressed = false;

// Where a screen point meets the terrain, in Skyrim units: walk along the camera ray
// until it dips below the ground, then refine. Far cheaper than ray-testing the mesh.
function groundAt(clientX, clientY) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(clientX / innerWidth * 2 - 1, -(clientY / innerHeight) * 2 + 1), camera);
  const { origin, direction } = ray.ray;
  const below = (t) => {
    const p = origin.clone().addScaledVector(direction, t);
    return p.y < world.heightAt(p.x / SCALE, -p.z / SCALE) * SCALE;
  };
  const step = Math.max(0.25, camera.position.distanceTo(controls.target) / 400);
  let t = 0;
  while (t < 4000 && !below(t)) t += step;
  if (t >= 4000) return null;
  let lo = t - step, hi = t;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (below(mid)) hi = mid; else lo = mid;
  }
  const p = origin.clone().addScaledVector(direction, hi);
  return { x: p.x / SCALE, y: -p.z / SCALE, z: p.y / SCALE };
}

function dropDestination(clientX, clientY) {
  const spot = groundAt(clientX, clientY);
  if (!spot) return;
  destination.set({ name: 'Marked spot', ...spot });
  showToast('Destination set. Tap ✕ on the banner to clear it.');
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  dropDestination(e.clientX, e.clientY);
});

canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, button: e.button, t: performance.now() });
  if (!popup.hidden) {
    popup.hidden = true;
    markers.focus(null);
  }
  clearTimeout(longPressTimer);
  longPressed = false;
  if (pointers.size === 1 && e.pointerType === 'touch') {
    longPressTimer = setTimeout(() => {
      const p = pointers.get(e.pointerId);
      if (!p || pointers.size !== 1 || Math.hypot(p.cx - p.x, p.cy - p.y) > 8) return;
      longPressed = true;
      dropDestination(p.cx, p.cy);
    }, LONG_PRESS_MS);
  }
  if (pointers.size === 2) {
    multiTouch = true;
    twist = { last: fingerAngle(), total: 0, active: false };
    // Following: pinch zooms on the player instead of drifting the view away.
    controls.enablePan = !follow;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.cx = e.clientX;
  p.cy = e.clientY;
  if (Math.hypot(p.cx - p.x, p.cy - p.y) > 8) clearTimeout(longPressTimer);
  if (pointers.size === 1 && follow && p.button === 0 && !multiTouch && Math.hypot(p.cx - p.x, p.cy - p.y) > 8) {
    setFollow(false);
  }
  if (pointers.size === 2 && twist) {
    const angle = fingerAngle();
    const delta = Math.atan2(Math.sin(angle - twist.last), Math.cos(angle - twist.last));
    twist.last = angle;
    twist.total += delta;
    if (!twist.active && Math.abs(twist.total) > TWIST_THRESHOLD) twist.active = true;
    if (twist.active) {
      // Orbit around the target so the map turns with the fingers.
      const offset = camera.position.clone().sub(controls.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, delta);
      camera.position.copy(controls.target).add(offset);
    }
  }
});

function endPointer(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  clearTimeout(longPressTimer);
  if (pointers.size < 2) {
    twist = null;
    controls.enablePan = true;
  }
  const tap = e.type === 'pointerup' && !multiTouch && !longPressed && e.button !== 2 && performance.now() - p.t < 450
    && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8;
  if (tap) {
    const radius = e.pointerType === 'touch' ? 30 : 16;
    const quest = questPins.pick(e.clientX, e.clientY, radius);
    const hit = quest ? null : markers.pick(e.clientX, e.clientY, radius);
    if (quest) showQuestPopup(quest);
    else if (hit) showMarkerPopup(hit.m, hit.el);
  }
  if (pointers.size === 0) multiTouch = false;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---------------------------------------------------------------- auto-update
// A phone tab or home-screen app can run for hours without a reload. Check whether
// the app's code changed on the server and reload so it never runs stale code.
(async () => {
  const version = () => fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((j) => j.version).catch(() => null);
  const loaded = await version();
  if (!loaded) return; // older server without the endpoint
  const check = async () => {
    const current = await version();
    if (current && current !== loaded) location.reload();
  };
  setInterval(check, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();

// ---------------------------------------------------------------- fullscreen
// Android/desktop browsers can go fullscreen from a button. iPhone Safari can't for web
// pages; there, the home-screen app (manifest + apple meta tags) opens without browser UI.
const fullscreenButton = $('btn-fullscreen');
const runningAsApp = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
const fullscreenSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
let toastTimer = 0;

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
}

const HOME_SCREEN_TIP = 'For full screen on iPhone or iPad: tap Share, then "Add to Home Screen". Open the map from that icon and the browser bars are gone.';
fullscreenButton.hidden = runningAsApp;
fullscreenButton.onclick = async () => {
  if (!fullscreenSupported) {
    showToast(HOME_SCREEN_TIP);
    return;
  }
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    return;
  }
  const root = document.documentElement;
  const refused = () => showToast('The browser refused full screen. Tap the button again, or add the map to your home screen and open it from there.');
  // Some embedded browsers never answer the request; treat silence as a refusal.
  const silence = setTimeout(() => { if (!document.fullscreenElement && !document.webkitFullscreenElement) refused(); }, 1500);
  try {
    await (root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen());
  } catch {
    clearTimeout(silence);
    refused();
  }
};
for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(type, () => {
    fullscreenButton.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement || document.webkitFullscreenElement)));
  });
}

// ---------------------------------------------------------------- panel / search / filters
const panel = $('panel');
function setPanel(open) {
  panel.classList.toggle('open', open);
  document.querySelector('.fabs').classList.toggle('lifted', open);
  $('btn-panel').setAttribute('aria-pressed', String(open));
  prefs.panel = open;
  savePrefs();
}
setPanel(prefs.panel && !isTouch);
$('btn-panel').onclick = () => setPanel(!panel.classList.contains('open'));
$('panel-grip').onclick = () => setPanel(false);

$('search').addEventListener('input', (e) => {
  const list = $('results');
  list.replaceChildren(...markers.search(e.target.value).map((m) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = m.name;
    li.lastChild.textContent = m.source ? `${m.kind} · ${m.source}` : m.kind;
    li.onclick = () => {
      setFollow(false);
      markers.focus(m);
      markerTick = 0;
      flyTo(toScene(m.x, m.y, m.z), 70);
      if (isTouch) setPanel(false);
    };
    return li;
  }));
});

const mapSelect = $('map-select');
mapSelect.replaceChildren(
  new Option('Auto: follow the game', 'auto'),
  ...datasets.map((d) => new Option(`${d.name} (${d.markers} locations)`, d.id)),
);
mapSelect.value = prefs.mapMode === 'auto' ? 'auto' : dataset.id;
$('map-current').textContent = prefs.mapMode === 'auto' ? `Showing ${dataset.name}` : '';
mapSelect.onchange = () => {
  prefs.mapMode = mapSelect.value;
  savePrefs();
  if (mapSelect.value !== 'auto') openMap(mapSelect.value);
  else $('map-current').textContent = `Showing ${dataset.name}`;
};

// Map builds run on the relay: the first time an unknown game connects, or on Rebuild.
let build = null;
let watchedBuild = false; // saw it running here (the relay replays its last status on connect)
const builtLabel = dataset.updated ? `Built ${dataset.updated}` : '';
$('map-build').textContent = builtLabel;
$('map-rebuild').onclick = async () => {
  $('map-rebuild').disabled = true;
  const reply = await fetch(`/api/rebuild?map=${encodeURIComponent(dataset.id)}`, { method: 'POST' })
    .then((r) => r.json()).catch(() => ({ ok: false, error: 'relay offline' }));
  if (!reply.ok) {
    $('map-build').textContent = reply.error;
    $('map-rebuild').disabled = false;
  }
};

function handleBuild(msg) {
  build = msg;
  const running = msg.state === 'running';
  if (running) watchedBuild = true;
  $('map-rebuild').disabled = running;
  $('map-build').textContent = running ? `Building ${msg.id === dataset.id ? 'this map' : 'a map'}: ${msg.line}`
    : msg.state === 'failed' && watchedBuild ? `Build failed: ${msg.error}` : builtLabel;
  // A new map for the game you're playing, or this one rebuilt: load it.
  if (msg.state === 'done' && watchedBuild && (msg.id === dataset.id || gameMatch === undefined)) location.reload();
}

$('styles').replaceChildren(...world.styles.map((s) => {
  const b = document.createElement('button');
  b.dataset.id = s.id;
  b.innerHTML = '<span></span><small></small>';
  b.firstChild.textContent = s.label;
  b.lastChild.textContent = s.source ?? '';
  b.title = s.source ? `${s.label}: from ${s.source}` : s.label;
  b.setAttribute('aria-pressed', String(s.id === world.style));
  b.onclick = () => setStyle(s.id);
  return b;
}));

// Place categories, plus on/off switches stored as booleans in prefs.
const SWITCHES = {
  mobs: { label: 'Creatures & NPCs', fallback: true, apply: () => { if (lastState?.actors) applyActors(lastState.actors); } },
  trail: { label: 'Walked trail', fallback: true, apply: (on) => trail.setVisible(on) },
  showUndiscovered: { label: 'Undiscovered places', fallback: false, apply: () => applyDiscovery() },
};
const switchOn = (key) => prefs[key] ?? SWITCHES[key].fallback;
const filterDefs = [...Object.entries(GROUPS).map(([key, g]) => [key, g.label]), ...Object.entries(SWITCHES).map(([key, s]) => [key, s.label])];
$('filters').replaceChildren(...filterDefs.map(([key, label]) => {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.textContent = label;
  const isOn = () => (key in SWITCHES ? switchOn(key) : prefs.groups.includes(key));
  chip.setAttribute('aria-pressed', String(isOn()));
  chip.onclick = () => {
    if (key in SWITCHES) {
      prefs[key] = !switchOn(key);
      SWITCHES[key].apply(prefs[key]);
    } else {
      prefs.groups = isOn() ? prefs.groups.filter((g) => g !== key) : [...prefs.groups, key];
      markers.setGroup(key, prefs.groups.includes(key));
    }
    chip.setAttribute('aria-pressed', String(isOn()));
    savePrefs();
  };
  return chip;
}), Object.assign(document.createElement('button'), {
  className: 'chip chip-action',
  textContent: 'Clear trail',
  onclick: () => {
    if (confirm(`Clear the walked trail for this character on this map (${trail.points} points)?`)) trail.clear();
  },
}));

function formatDistance(units) {
  const m = units * METERS_PER_UNIT;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function distanceText(x, y) {
  return lastExterior ? ` · ${formatDistance(Math.hypot(x - lastExterior.x, y - lastExterior.y))} away` : '';
}

// `goTo` (a place with name/x/y/z) adds a "Set destination" button.
function showPopup(anchor, title, detail, note, goTo) {
  const rect = anchor.getBoundingClientRect();
  popup.innerHTML = '<b></b><span></span><em></em>';
  popup.children[0].textContent = title;
  popup.children[1].textContent = detail;
  popup.children[2].textContent = note;
  if (goTo) {
    const button = document.createElement('button');
    button.className = 'popup-action';
    const already = destination.target && destination.target.x === goTo.x && destination.target.y === goTo.y;
    button.textContent = already ? '✕ Clear destination' : '⚑ Set destination';
    button.onclick = () => {
      if (already) destination.clear(); else destination.set(goTo);
      popup.hidden = true;
    };
    popup.appendChild(button);
  }
  popup.style.left = `${rect.left + rect.width / 2}px`;
  popup.style.top = `${rect.top}px`;
  popup.hidden = false;
}

function showMarkerPopup(m, el) {
  markers.focus(m);
  markerTick = 0;
  const known = discoveryState(m.id);
  const status = known === 'discovered' ? ' · Discovered' : known === 'known' ? ' · Heard of, not visited' : known === 'undiscovered' ? ' · Undiscovered' : '';
  showPopup(el.querySelector('.ico'), m.name, `${m.kind}${status}${distanceText(m.x, m.y)}`, m.source ? `Added by ${m.source}` : '',
    { name: m.name, x: m.x, y: m.y, z: m.z });
}

function showQuestPopup({ el, quest, target }) {
  const where = target.inside ? `Inside ${target.inside}` : 'Quest target';
  showPopup(el.firstChild, quest.name, target.text || quest.objectives[0] || '', `${where}${distanceText(target.x, target.y)}`,
    { name: target.inside || quest.name, x: target.x, y: target.y, z: target.z });
}

// ---------------------------------------------------------------- discovered places
// The plugin reports which map markers you've discovered (can fast travel) or only
// heard of. Until it does (older plugin), every place shows as before.
let discovery = null; // Map of marker id -> 'discovered' | 'known'
let discoveryBatch = null;

function discoveryState(id) {
  if (!discovery) return null;
  return discovery.get(id) ?? 'undiscovered';
}

function applyDiscovery() {
  markers.setDiscovery(discovery, switchOn('showUndiscovered'));
  markerTick = 0;
}

function handleDiscovered(msg) {
  if (!discoveryBatch || discoveryBatch.seq !== msg.seq) discoveryBatch = { seq: msg.seq, parts: msg.parts, got: new Set(), entries: [] };
  if (discoveryBatch.got.has(msg.part)) return;
  discoveryBatch.got.add(msg.part);
  for (const id of msg.discovered) discoveryBatch.entries.push([id, 'discovered']);
  for (const id of msg.known) discoveryBatch.entries.push([id, 'known']);
  if (discoveryBatch.got.size === discoveryBatch.parts) {
    discovery = new Map(discoveryBatch.entries);
    applyDiscovery();
  }
}

// ---------------------------------------------------------------- quests
function handleQuests(msg) {
  questPins.set(msg.quests);
  const list = $('quests');
  $('quest-count').textContent = msg.quests.length ? String(msg.quests.length) : '';
  if (!msg.quests.length) {
    list.innerHTML = '<li class="empty">No quest selected. Pick one in your journal to see its markers.</li>';
    return;
  }
  list.replaceChildren(...msg.quests.map((quest) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="qname"></span><ul class="objectives"></ul>';
    li.firstChild.textContent = quest.name;
    for (const text of quest.objectives) {
      const item = document.createElement('li');
      item.textContent = text;
      li.lastChild.appendChild(item);
    }
    const target = quest.targets[0];
    if (target) {
      li.classList.add('has-target');
      li.onclick = () => {
        setFollow(false);
        flyTo(toScene(target.x, target.y, target.z), 60);
        if (isTouch) setPanel(false);
      };
    }
    return li;
  }));
}

// ---------------------------------------------------------------- live data
let lastState = null;
let lastExterior = null;
let lastPacket = 0;
let socketOpen = false;
let gameMatch = null; // dataset for the game folder the plugin reports (undefined = no map built)

function onTamrielMap(s) {
  return s.ws === TAMRIEL || s.wsParent === TAMRIEL;
}

function followGame(gameDir) {
  if (!gameDir || gameMatch !== null) return;
  gameMatch = datasets.find((d) => d.gamePath === normPath(gameDir));
  if (!gameMatch || prefs.mapMode !== 'auto') return;
  prefs.lastMap = gameMatch.id;
  savePrefs();
  if (gameMatch.id !== dataset.id) openMap(gameMatch.id);
}

function handleState(s) {
  lastPacket = performance.now();
  followGame(s.game);
  const outside = !s.interior && onTamrielMap(s);
  if (outside) {
    lastExterior = s;
    trail.add(s.x, s.y, s.z);
    destination.update(s);
    buildings.update(s);
  }
  if (lastExterior) player.setState(lastExterior, !outside);

  $('place-name').textContent = (s.interior ? s.cell : s.location) || s.location || 'Skyrim';
  $('place-sub').textContent = s.interior ? (s.location && s.location !== s.cell ? s.location : 'Interior')
    : !onTamrielMap(s) ? 'Off the map' : s.location ? 'Skyrim' : 'Wilderness';

  // Position packets come 10×/s: keep level and the health bar smooth from them; the
  // once-a-second player packet fills in everything else.
  $('player-card').hidden = false;
  $('pc-level').textContent = s.lvl ?? '–';
  $('pc-health').style.width = `${Math.round((s.hp ?? 1) * 100)}%`;
  $('pc-coords').textContent = `${Math.round(s.x)}, ${Math.round(s.y)}`;
  if (!hasPlayerStats) {
    $('pc-flags').innerHTML = [s.combat && '<span class="combat">⚔ In combat</span>', s.mounted && '<span>🐎 Mounted</span>'].filter(Boolean).join('');
  }

  $('compass').hidden = false;
  compass.setHeading(s.h ?? 0);
  // Targets are in world coordinates, so they only make sense outside.
  const marks = [];
  if (outside) {
    for (const pin of questPins.pins.values()) marks.push({ deg: bearing(s.x, s.y, pin.target.x, pin.target.y), kind: 'quest' });
    const t = destination.target;
    if (t) marks.push({ deg: bearing(s.x, s.y, t.x, t.y), kind: 'dest' });
  }
  compass.setMarks(marks);

  $('interior').hidden = !s.interior;
  $('interior-name').textContent = s.cell || 'Interior';
  if (s.interior) {
    interiorMap.update(s);
    interiorMap.show();
  } else {
    interiorMap.hide();
  }

  lastState = { ...s, actors: s.actors ?? lastState?.actors };
  if (s.actors) applyActors(s.actors); // plugin 0.2.0 embedded actors in the state packet
}

// ---------------------------------------------------------------- player card
let hasPlayerStats = false;

function setStat(id, [cur, max]) {
  $(`pc-${id}`).style.width = `${max > 0 ? Math.round(Math.max(0, cur) / max * 100) : 0}%`;
}

function handlePlayer(p) {
  hasPlayerStats = true;
  trail.setOwner(p.name);
  $('pc-name').textContent = p.name || 'You';
  $('pc-race').textContent = p.race || '';
  $('pc-level').textContent = p.lvl;
  $('pc-perks').textContent = p.perks > 0 ? `${p.perks} perk point${p.perks === 1 ? '' : 's'}` : '';
  $('pc-xp').style.width = `${Math.round(p.xp * 100)}%`;
  setStat('health', p.hp);
  setStat('magicka', p.mp);
  setStat('stamina', p.sp);
  $('pc-hp-text').textContent = `${Math.max(0, p.hp[0])} / ${p.hp[1]}`;
  $('pc-mp-text').textContent = `${Math.max(0, p.mp[0])} / ${p.mp[1]}`;
  $('pc-sp-text').textContent = `${Math.max(0, p.sp[0])} / ${p.sp[1]}`;
  $('pc-gold').textContent = p.gold.toLocaleString();
  $('pc-carry').textContent = `${p.carry[0]} / ${p.carry[1]}`;
  $('pc-carry').classList.toggle('heavy', p.carry[0] > p.carry[1]);
  $('pc-souls-wrap').hidden = !(p.souls > 0);
  $('pc-souls').textContent = p.souls;
  const eq = [];
  if (p.right) eq.push(`<span>Right: <b></b></span>`);
  if (p.left && p.left !== p.right) eq.push(`<span>Left: <b></b></span>`);
  $('pc-eq').innerHTML = eq.join('<br>');
  const names = [p.right, p.left !== p.right ? p.left : null].filter(Boolean);
  $('pc-eq').querySelectorAll('b').forEach((b, i) => { b.textContent = names[i]; });
  $('pc-flags').innerHTML = [
    p.combat && '<span class="combat">⚔ In combat</span>',
    p.sneak && '<span>👁 Sneaking</span>',
    p.drawn && '<span>🗡 Weapon drawn</span>',
    p.mounted && '<span>🐎 Mounted</span>',
  ].filter(Boolean).join('');
  $('pc-time').textContent = p.time || '';
}

const card = $('player-card');
function setCardExpanded(open) {
  card.classList.toggle('collapsed', !open);
  $('pc-toggle').setAttribute('aria-expanded', String(open));
  prefs.cardExpanded = open;
  savePrefs();
}
setCardExpanded(prefs.cardExpanded ?? !isTouch);
$('pc-toggle').onclick = () => setCardExpanded(card.classList.contains('collapsed'));

// ---------------------------------------------------------------- legend
$('legend-body').innerHTML = [
  ...Object.entries(DISPOSITIONS).map(([state, d]) => {
    const icons = state === 'dead' ? [iconURL('dead', 'dead')] : [iconURL('npc', state, state === 'hostile'), iconURL('creature', state)];
    return `<div class="legend-row"><span class="icons">${icons.map((src) => `<img src="${src}" alt="">`).join('')}</span><span><b>${d.label}</b><small>${d.hint}</small></span></div>`;
  }),
  `<div class="legend-row"><span class="icons"><img src="${iconURL('npc', 'neutral')}" alt=""><img src="${iconURL('creature', 'neutral')}" alt=""></span><span><b>Person / creature</b><small>The symbol inside shows what it is.</small></span></div>`,
  `<div class="legend-row"><span class="icons"><img src="${iconURL('dragon', 'hostile', true)}" alt=""></span><span><b>Dragon</b><small>Drawn larger so you can't miss it.</small></span></div>`,
  `<div class="legend-row"><span class="icons"><span class="glyph" style="background:var(--quest);border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span></span><span><b>Quest target</b><small>For quests selected in your journal.</small></span></div>`,
  `<div class="legend-row"><span class="icons"><span class="glyph">♜</span><span class="glyph" style="background:#b9b3a6">✠</span></span><span><b>Places</b><small>♜ cities &amp; towns · ✠ dungeons · ▲ camps · ✦ landmarks</small></span></div>`,
].join('');

function applyActors(list) {
  if (!lastState) return;
  const s = { ...lastState, actors: list };
  actors.setActors(list, !s.interior && onTamrielMap(s) && prefs.mobs);
  if (s.interior) interiorMap.setActors(list);
  renderNearby(s);
  lastState = s;
}

// Plugin 0.3+ sends actors in numbered batches; apply the list once a batch is complete.
let actorBatch = null;
function handleActors(msg) {
  if (!actorBatch || actorBatch.seq !== msg.seq) actorBatch = { seq: msg.seq, parts: msg.parts, got: new Set(), list: [] };
  if (actorBatch.got.has(msg.part)) return;
  actorBatch.got.add(msg.part);
  actorBatch.list.push(...msg.actors);
  if (actorBatch.got.size === actorBatch.parts) applyActors(actorBatch.list);
}

function renderNearby(s) {
  const list = (s.actors ?? []).map((a) => ({ ...a, dist: distanceUnits(a, s) }));
  const rank = { hostile: 0, ally: 1, neutral: 2, dead: 3 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || a.dist - b.dist);
  const hostiles = list.filter((a) => a.state === 'hostile').length;
  // The radar ignores the filter, so say when it's what keeps dots off the world map.
  const hidden = !prefs.mobs && list.length ? ' · map dots off (filter)' : '';
  $('nearby-count').textContent = list.length ? `${list.length}${hostiles ? ` · ${hostiles} hostile` : ''}${hidden}` : '';
  const ul = $('nearby');
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No one around.</li>';
    return;
  }
  ul.replaceChildren(...list.slice(0, 50).map((a) => {
    const li = document.createElement('li');
    const badge = iconURL(actorKind(a), a.state, a.combat && a.state === 'hostile');
    li.innerHTML = `<img class="sw" src="${badge}" alt="${DISPOSITIONS[a.state]?.label ?? ''}"><span class="nm"></span><span class="meta"></span><div class="bar"><div class="fill" style="width:${Math.round(a.hp * 100)}%"></div></div>`;
    li.querySelector('.nm').textContent = a.name || a.race || 'Unknown';
    li.querySelector('.meta').textContent = `Lv ${a.lvl} · ${formatDistance(a.dist)}`;
    li.onclick = () => {
      if (s.interior) return;
      setFollow(false);
      flyTo(toScene(a.x, a.y, a.z), 25);
    };
    return li;
  }));
}

function setStatus(kind, text) {
  $('status').className = `status ${kind}`;
  $('status-text').textContent = text;
}

connectLive({
  onOpen: () => { socketOpen = true; },
  onClose: () => { socketOpen = false; },
  onState: handleState,
  onActors: handleActors,
  onQuests: handleQuests,
  onPlayer: handlePlayer,
  onDiscovered: handleDiscovered,
  onInventory: (msg) => sheet.receive('inventory', msg),
  onMagic: (msg) => sheet.receive('magic', msg),
  onInput: (msg) => remote.handle(msg),
  onBuild: handleBuild,
});

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let markerTick = 0;

function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; }

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  remote.tick(dt);

  if (flight) {
    flight.t = Math.min(flight.t + dt / 0.9, 1);
    const k = ease(flight.t);
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    camera.position.lerpVectors(flight.fromC, flight.toC, k);
    if (flight.t >= 1) flight = null;
  } else if (follow && player.hasFix) {
    // Jump straight onto the player the first time; glide after that.
    const k = snappedToPlayer ? 1 - Math.exp(-dt * 4) : 1;
    snappedToPlayer = true;
    const delta = player.object.position.clone().sub(controls.target).multiplyScalar(k);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  controls.update();

  compass.draw(dt);
  player.update(dt, camera);
  actors.showNames = prefs.mobs;
  actors.update(dt, camera);

  markerTick -= dt;
  if (markerTick <= 0) {
    markers.update(camera);
    markerTick = 0.15;
  }

  const age = performance.now() - lastPacket;
  if (!socketOpen) setStatus('offline', 'Relay offline');
  else if (age > 3000) setStatus('waiting', lastPacket ? 'Game paused or closed' : 'Waiting for game…');
  else if (build?.state === 'running') setStatus('live', 'Live · building the map…');
  else if (gameMatch === undefined) setStatus('live', 'Live · no map built for this game');
  else if (gameMatch && gameMatch.id !== dataset.id) setStatus('live', `Live · game is ${gameMatch.name}`);
  else setStatus('live', 'Live');

  if (lastState?.interior && !interiorMap.ready) drawRadar($('radar'), lastState);

  renderer.render(scene, camera);
  labels.render(scene, camera);
  questLabels.render(questScene, camera);
});

// Handy for debugging from the console.
Object.assign(window, { THREE, scene, camera, controls, world, SCALE, questPins });
