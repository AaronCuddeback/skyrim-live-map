// The live player marker and nearby actors (mobs, followers, NPCs).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { actorKind, iconTexture } from './icons.js';
import { toScene } from './world.js';

function angleLerp(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

// Keep markers a readable size on screen regardless of zoom.
function screenScale(camera, obj, px) {
  const d = camera.position.distanceTo(obj.position);
  return Math.max(d * px * 0.0016, 0.05);
}

export function createPlayer(scene) {
  const group = new THREE.Group();

  const shape = new THREE.Shape();
  shape.moveTo(0, -1.2); shape.lineTo(0.85, 0.9); shape.lineTo(0, 0.45); shape.lineTo(-0.85, 0.9); shape.closePath();
  const arrowGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 });
  arrowGeo.rotateX(-Math.PI / 2); // lay flat, tip pointing -Z (north)
  arrowGeo.rotateY(Math.PI);
  arrowGeo.translate(0, 0.2, 0);
  const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xf3d58a }));
  const outline = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x1a1408, side: THREE.BackSide }));
  outline.scale.setScalar(1.18);
  const heading = new THREE.Group();
  heading.add(outline, arrow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.3, 1.55, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xf3d58a, transparent: true, depthWrite: false }),
  );
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 60, 8, 1, true).translate(0, 30, 0),
    new THREE.MeshBasicMaterial({ color: 0xf3d58a, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  group.add(heading, ring, beam);
  group.visible = false;
  // Always drawn over terrain; render order decides what stacks on top.
  [[beam, 8], [ring, 9], [outline, 10], [arrow, 11]].forEach(([mesh, order]) => {
    mesh.material.depthTest = false;
    mesh.renderOrder = order;
  });
  scene.add(group);

  const target = new THREE.Vector3();
  let targetHeading = 0, currentHeading = 0, hasFix = false, pulse = 0;

  return {
    object: group,
    get hasFix() { return hasFix; },
    setState(s, inside) {
      toScene(s.x, s.y, s.z, target);
      targetHeading = -s.h;
      if (!hasFix) { group.position.copy(target); currentHeading = targetHeading; hasFix = true; }
      group.visible = true;
      arrow.material.color.set(inside ? 0x8f8a7c : 0xf3d58a);
      beam.visible = !inside;
    },
    update(dt, camera) {
      if (!hasFix) return;
      const k = 1 - Math.exp(-dt * 8);
      group.position.lerp(target, k);
      currentHeading = angleLerp(currentHeading, targetHeading, k);
      heading.rotation.y = currentHeading;
      const s = screenScale(camera, group, 8.7);
      heading.scale.setScalar(s);
      pulse = (pulse + dt * 0.8) % 1;
      ring.scale.setScalar(s * (1 + pulse * 1.6));
      ring.material.opacity = 0.8 * (1 - pulse);
      beam.scale.set(s * 2, 1, s * 2);
    },
  };
}

// On-screen badge size in CSS pixels, by kind.
const BADGE_PX = { npc: 24, creature: 24, dragon: 38, dead: 17 };

export function createActors(scene) {
  const pool = new Map(); // formId -> { mesh, tag, target, data, kind }
  let showNames = true;

  function make(a) {
    // A sprite always faces the camera; drawn on top of terrain, which the decimated
    // mesh would otherwise let swallow small markers.
    const kind = actorKind(a);
    const mesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture(kind, a.state, a.combat && a.state === 'hostile'), depthTest: false, sizeAttenuation: false }));
    mesh.renderOrder = 9;
    const el = document.createElement('div');
    el.className = 'actor-tag';
    const tag = new CSS2DObject(el);
    mesh.add(tag);
    scene.add(mesh);
    const entry = { mesh, el, tag, target: new THREE.Vector3(), data: a };
    toScene(a.x, a.y, a.z + 80, mesh.position);
    pool.set(a.id, entry);
    return entry;
  }

  return {
    pool,
    set showNames(v) { showNames = v; },
    setActors(list, visible) {
      const seen = new Set();
      for (const a of list ?? []) {
        seen.add(a.id);
        const e = pool.get(a.id) ?? make(a);
        e.data = a;
        e.kind = actorKind(a);
        toScene(a.x, a.y, a.z + 80, e.target);
        e.mesh.material.map = iconTexture(e.kind, a.state, a.combat && a.state === 'hostile');
        e.el.textContent = a.state === 'dead' ? `${a.name} ✝` : `${a.name} · ${a.lvl}`;
        e.el.classList.toggle('hostile-tag', a.state === 'hostile');
        e.mesh.visible = visible;
      }
      for (const [id, e] of pool) {
        if (!seen.has(id)) {
          scene.remove(e.mesh);
          e.tag.element.remove();
          e.mesh.material.dispose(); // the shared badge texture stays cached
          pool.delete(id);
        }
      }
    },
    update(dt, camera) {
      const k = 1 - Math.exp(-dt * 5);
      // With sizeAttenuation off, sprite scale is a fraction of the view's height
      // (times 2·tan(fov/2)): this keeps badges a fixed pixel size at any zoom.
      const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
      for (const e of pool.values()) {
        e.mesh.position.lerp(e.target, k);
        e.mesh.scale.setScalar((BADGE_PX[e.kind] ?? 24) * perPixel);
        const d = camera.position.distanceTo(e.mesh.position);
        const nameRange = e.data.state === 'hostile' ? 80 : e.data.state === 'dead' ? 15 : 40;
        e.tag.visible = showNames && e.mesh.visible && d < nameRange;
      }
    },
  };
}

export function distanceUnits(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}
