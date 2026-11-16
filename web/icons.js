// Actor badges: one drawing per (kind, disposition, fighting) shared by the map, the
// Nearby list and the legend, so all three always match.
import * as THREE from 'three';

export const DISPOSITIONS = {
  hostile: { color: '#e05252', label: 'Hostile', hint: 'Will attack you. A white ring means fighting right now.' },
  neutral: { color: '#e3cf8c', label: 'Neutral', hint: "Townsfolk, traders, guards and wildlife that leave you alone unless provoked." },
  ally: { color: '#55c776', label: 'Ally', hint: 'Followers, summons and anyone fighting on your side.' },
  dead: { color: '#8a8780', label: 'Dead', hint: 'Bodies, still lootable.' },
};

export const KINDS = { npc: 'Person', creature: 'Creature', dragon: 'Dragon', dead: 'Dead' };

export function actorKind(a) {
  if (a.state === 'dead') return 'dead';
  const race = a.race ?? '';
  if (/dragon/i.test(race) && !/priest/i.test(race)) return 'dragon';
  return a.npc ? 'npc' : 'creature';
}

const SIZE = 64;
const INK = '#16120a';

function drawGlyph(ctx, kind, color) {
  ctx.fillStyle = INK;
  ctx.beginPath();
  switch (kind) {
    case 'npc': // head and shoulders
      ctx.arc(32, 23, 7.5, 0, Math.PI * 2);
      ctx.moveTo(17, 47);
      ctx.quadraticCurveTo(17, 32, 32, 32);
      ctx.quadraticCurveTo(47, 32, 47, 47);
      ctx.closePath();
      break;
    case 'creature': // paw print
      ctx.ellipse(32, 39, 9, 7.5, 0, 0, Math.PI * 2);
      for (const [x, y] of [[20, 29], [27, 21], [37, 21], [44, 29]]) {
        ctx.moveTo(x + 4.2, y);
        ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      }
      break;
    case 'dragon': // spread wings over a body
      ctx.moveTo(32, 25);
      ctx.lineTo(13, 17); ctx.lineTo(18, 30); ctx.lineTo(13, 34); ctx.lineTo(27, 36);
      ctx.lineTo(32, 47);
      ctx.lineTo(37, 36); ctx.lineTo(51, 34); ctx.lineTo(46, 30); ctx.lineTo(51, 17);
      ctx.closePath();
      break;
    case 'dead': // skull
      ctx.arc(32, 28, 11, 0, Math.PI * 2);
      ctx.rect(26, 33, 12, 9);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(28, 28, 3.2, 0, Math.PI * 2);
      ctx.moveTo(39.2, 28);
      ctx.arc(36, 28, 3.2, 0, Math.PI * 2);
      ctx.rect(29.5, 38, 1.6, 4);
      ctx.rect(33, 38, 1.6, 4);
      break;
  }
  ctx.fill();
}

const canvases = new Map();
function iconCanvas(kind, state, fighting) {
  const key = `${kind}|${state}|${fighting}`;
  if (!canvases.has(key)) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const color = DISPOSITIONS[state]?.color ?? DISPOSITIONS.neutral.color;
    if (fighting) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(32, 32, 29, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    drawGlyph(ctx, kind, color);
    canvases.set(key, canvas);
  }
  return canvases.get(key);
}

const textures = new Map();
export function iconTexture(kind, state, fighting = false) {
  const key = `${kind}|${state}|${fighting}`;
  if (!textures.has(key)) {
    const texture = new THREE.CanvasTexture(iconCanvas(kind, state, fighting));
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.set(key, texture);
  }
  return textures.get(key);
}

const urls = new Map();
export function iconURL(kind, state, fighting = false) {
  const key = `${kind}|${state}|${fighting}`;
  if (!urls.has(key)) urls.set(key, iconCanvas(kind, state, fighting).toDataURL());
  return urls.get(key);
}
