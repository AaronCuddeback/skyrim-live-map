// Local maps from the game's own models (built on demand by the server, see
// tools/localmap.py): a cutaway floor plan of the interior you're in, and the
// buildings and walls around you outdoors.
import * as THREE from 'three';
import { actorKind, iconTexture } from './icons.js';

const CELL = 4096;

// Geometry for one cell: positions in Skyrim units, in scene axes (x, z, -y) × scale.
async function loadLocal(query, scale) {
  const reply = await fetch(`/api/local?${query}`).then((r) => r.json());
  if (!reply.ok) throw new Error(reply.error || 'local map unavailable');
  const meta = reply.meta;
  const quantized = new Uint16Array(await fetch(`data/${reply.file}`).then((r) => r.arrayBuffer()));
  const [x0, y0, z0, x1, y1, z1] = meta.bounds;
  const sx = (x1 - x0) / 65535, sy = (y1 - y0) / 65535, sz = (z1 - z0) / 65535;
  const positions = new Float32Array(quantized.length);
  for (let i = 0; i < quantized.length; i += 3) {
    positions[i] = (x0 + quantized[i] * sx) * scale;
    positions[i + 1] = (z0 + quantized[i + 2] * sz) * scale;
    positions[i + 2] = -(y0 + quantized[i + 1] * sy) * scale;
  }
  return { meta, positions };
}

function geometryFrom(positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); // flat: triangles share no vertices
  return geometry;
}

function doorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#7fd3ff';
  g.strokeStyle = '#08212c';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#08212c';
  g.fillRect(23, 17, 18, 30); // a door
  g.fillStyle = '#7fd3ff';
  g.fillRect(35, 31, 3, 3);   // its handle
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- interior cutaway

const S = 0.01;            // interior scene scale: 1 unit = 100 game units
const CUT_ABOVE = 200;     // keep geometry up to this far above the player's feet
const BG = 0x141519;

export function createInteriorMap({ container, status, mapId, onState }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 3, 16); // lower levels fade into the background
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3630, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  camera.up.set(0, 0, -1); // north (-z) at the top
  let viewHeight = 2600;   // game units shown top to bottom

  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const material = new THREE.MeshLambertMaterial({ color: 0xd2c6ab, side: THREE.DoubleSide, clippingPlanes: [clip] });
  let mesh = null;

  // You: a gold arrow drawn over everything.
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.2); shape.lineTo(0.85, 0.9); shape.lineTo(0, 0.45); shape.lineTo(-0.85, 0.9); shape.closePath();
  const arrowGeometry = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).rotateY(Math.PI);
  const arrow = new THREE.Mesh(arrowGeometry, new THREE.MeshBasicMaterial({ color: 0xf3d58a, depthTest: false }));
  const outline = new THREE.Mesh(arrowGeometry, new THREE.MeshBasicMaterial({ color: 0x1a1408, depthTest: false }));
  outline.scale.setScalar(1.25);
  outline.renderOrder = 10;
  arrow.renderOrder = 11;
  const you = new THREE.Group();
  you.add(outline, arrow);
  scene.add(you);

  const doorMaterial = new THREE.SpriteMaterial({ map: doorTexture(), depthTest: false });
  const doors = new THREE.Group();
  scene.add(doors);
  const actorSprites = new Map();
  const actorGroup = new THREE.Group();
  scene.add(actorGroup);

  let cellKey = null;
  let state = 'idle'; // idle | loading | ready | failed
  let player = null;
  let visible = false;
  let frame = 0;

  function setState(next, text = '') {
    state = next;
    status.textContent = text;
    status.hidden = !text;
    renderer.domElement.style.visibility = next === 'ready' ? 'visible' : 'hidden';
    onState?.(next);
  }

  async function load(key, name) {
    cellKey = key;
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    doors.clear();
    setState('loading', `Drawing the map of ${name || 'this place'}… (the first visit takes a few seconds)`);
    try {
      const { meta, positions } = await loadLocal(`map=${encodeURIComponent(mapId)}&cell=${encodeURIComponent(key)}`, S);
      if (cellKey !== key) return; // moved on while loading
      if (!meta.triangles) throw new Error('nothing to draw here');
      mesh = new THREE.Mesh(geometryFrom(positions), material);
      scene.add(mesh);
      for (const [x, y, z] of meta.doors) {
        const sprite = new THREE.Sprite(doorMaterial);
        sprite.position.set(x * S, z * S + 0.5, -y * S);
        sprite.renderOrder = 9;
        doors.add(sprite);
      }
      setState('ready');
    } catch (err) {
      if (cellKey === key) setState('failed', '');
      console.warn('interior map:', err.message);
    }
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = (-viewHeight * aspect / 2) * S;
    camera.right = (viewHeight * aspect / 2) * S;
    camera.top = (viewHeight / 2) * S;
    camera.bottom = (-viewHeight / 2) * S;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

  function draw() {
    frame = visible ? requestAnimationFrame(draw) : 0;
    if (!player || state !== 'ready') return;
    const px = player.x * S, py = player.z * S, pz = -player.y * S;
    clip.constant = (player.z + CUT_ABOVE) * S;
    camera.position.set(px, clip.constant + 2, pz);
    camera.lookAt(px, clip.constant, pz); // straight down, at any depth
    resize();
    // Constant on-screen sizes: units per CSS pixel of the view.
    const perPx = (viewHeight * S) / Math.max(container.clientHeight, 1);
    you.position.set(px, py + 0.2, pz);
    you.rotation.y = -player.h;
    you.scale.setScalar(perPx * 11);
    for (const sprite of doors.children) sprite.scale.setScalar(perPx * 22);
    for (const sprite of actorGroup.children) sprite.scale.setScalar(perPx * (sprite.userData.kind === 'dead' ? 16 : 22));
    renderer.render(scene, camera);
  }

  function zoom(factor) {
    viewHeight = Math.min(Math.max(viewHeight * factor, 600), 20000);
    resize();
  }
  renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  // Pinch to zoom.
  const touches = new Map();
  let pinch = 0;
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.addEventListener('pointerdown', (e) => touches.set(e.pointerId, e));
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, e);
    if (touches.size !== 2) return;
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch) zoom(pinch / d);
    pinch = d;
  });
  for (const type of ['pointerup', 'pointercancel']) {
    renderer.domElement.addEventListener(type, (e) => { touches.delete(e.pointerId); pinch = 0; });
  }

  return {
    get ready() { return state === 'ready'; },
    zoom,
    // Each interior position update.
    update(s) {
      player = s;
      if (s.cellKey && s.cellKey !== cellKey) load(s.cellKey, s.cell);
      if (!s.cellKey && state !== 'failed') setState('failed', '');
    },
    setActors(list) {
      const seen = new Set();
      for (const a of list ?? []) {
        seen.add(a.id);
        let sprite = actorSprites.get(a.id);
        if (!sprite) {
          sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false }));
          sprite.renderOrder = 9;
          actorSprites.set(a.id, sprite);
          actorGroup.add(sprite);
        }
        const kind = actorKind(a);
        sprite.userData.kind = kind;
        sprite.material.map = iconTexture(kind, a.state, a.combat && a.state === 'hostile');
        sprite.material.needsUpdate = true;
        sprite.position.set(a.x * S, a.z * S + 0.6, -a.y * S);
      }
      for (const [id, sprite] of actorSprites) {
        if (!seen.has(id)) {
          actorGroup.remove(sprite);
          sprite.material.dispose();
          actorSprites.delete(id);
        }
      }
    },
    show() {
      if (visible) return;
      visible = true;
      frame = requestAnimationFrame(draw);
    },
    hide() {
      visible = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

// ---------------------------------------------------------------- buildings outdoors

// Buildings, walls and bridges of the cells around you, added to the 3D map.
export function createBuildings(scene, mapId) {
  const material = new THREE.MeshLambertMaterial({ color: 0xb8ad97, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  const cells = new Map(); // "x|y" -> { mesh }
  let world = null;

  function drop(key) {
    const cell = cells.get(key);
    if (cell?.mesh) {
      scene.remove(cell.mesh);
      cell.mesh.geometry.dispose();
    }
    cells.delete(key);
  }

  async function load(key, ws, x, y) {
    const cell = { mesh: null };
    cells.set(key, cell);
    try {
      const { meta, positions } = await loadLocal(`map=${encodeURIComponent(mapId)}&world=${encodeURIComponent(ws)}&x=${x}&y=${y}`, 1 / 1000);
      if (cells.get(key) !== cell || !meta.triangles) return;
      cell.mesh = new THREE.Mesh(geometryFrom(positions), material);
      cell.mesh.renderOrder = 2;
      scene.add(cell.mesh);
    } catch (err) {
      console.warn('buildings:', err.message);
    }
  }

  return {
    // Each outdoor position update: keep the 3×3 cells around you loaded.
    update(s) {
      if (!s.wsKey) return;
      if (s.wsKey !== world) {
        for (const key of [...cells.keys()]) drop(key);
        world = s.wsKey;
      }
      const cx = Math.floor(s.x / CELL), cy = Math.floor(s.y / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${cx + dx}|${cy + dy}`;
          if (!cells.has(key)) load(key, world, cx + dx, cy + dy);
        }
      }
      for (const key of [...cells.keys()]) {
        const [x, y] = key.split('|').map(Number);
        if (Math.abs(x - cx) > 2 || Math.abs(y - cy) > 2) drop(key);
      }
    },
    setColor(color) {
      material.color.set(color);
    },
  };
}
