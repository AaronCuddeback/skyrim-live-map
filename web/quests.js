// Pins for the quests the player is tracking in their journal. They live in their
// own scene + label layer so they always draw above location markers.
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { toScene } from './world.js';

export function createQuestPins(scene) {
  const pins = new Map(); // "questId:targetIndex" -> { el, obj, quest, target }

  function set(quests) {
    const seen = new Set();
    for (const quest of quests) {
      quest.targets.forEach((target, i) => {
        const key = `${quest.id}:${i}`;
        seen.add(key);
        let pin = pins.get(key);
        if (!pin) {
          const el = document.createElement('div');
          el.className = 'qp';
          el.innerHTML = '<span class="qico"></span><span class="qlbl"></span>';
          const obj = new CSS2DObject(el);
          obj.center.set(0.5, 1); // the pin's tip marks the spot
          scene.add(obj);
          pin = { el, obj };
          pins.set(key, pin);
        }
        Object.assign(pin, { quest, target });
        pin.el.lastChild.textContent = quest.name;
        toScene(target.x, target.y, target.z + 200, pin.obj.position);
      });
    }
    for (const [key, pin] of pins) {
      if (!seen.has(key)) {
        scene.remove(pin.obj);
        pin.el.remove();
        pins.delete(key);
      }
    }
  }

  // Nearest pin to a tap, like location markers (pins don't take pointer events).
  function pick(x, y, radius) {
    let best = null, bestDist = radius;
    for (const pin of pins.values()) {
      if (pin.el.style.display === 'none') continue;
      const r = pin.el.firstChild.getBoundingClientRect();
      const dist = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (dist < bestDist) {
        best = pin;
        bestDist = dist;
      }
    }
    return best;
  }

  return { set, pick, pins };
}
