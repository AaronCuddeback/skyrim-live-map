// Terrain + water built from the data that tools/extract_map.py pulls out of Skyrim.esm.
import * as THREE from 'three';

// Skyrim units -> scene units. Skyrim: X east, Y north, Z up. Scene: X east, Y up, -Z north.
export const SCALE = 1 / 1000;
export const METERS_PER_UNIT = 0.01428;

export function toScene(x, y, z, out = new THREE.Vector3()) {
  return out.set(x * SCALE, z * SCALE, -y * SCALE);
}

// How each map style wants the scene lit and its sea drawn.
export const STYLE_LOOK = {
  terrain: { background: 0x15191f, water: 0x1d3f55, waterOpacity: 0.82, ambient: 2.6, sun: 1.1, buildings: 0xb8ad97 },
  paper: { background: 0x1f1b14, water: 0xa6b5a8, waterOpacity: 0.5, ambient: 3.1, sun: 0.35, buildings: 0x7a5e3c },
  worldmap: { background: 0x15191f, water: 0x2b4a5c, waterOpacity: 0.78, ambient: 2.6, sun: 1.0, buildings: 0xa89c86 },
};

export async function loadWorld(renderer, { base, decimate = 1, style = 'terrain' } = {}) {
  const meta = await fetch(`${base}terrain.json`).then((r) => r.json());
  const styles = meta.styles;
  const initial = styles.find((s) => s.id === style) ?? styles[0];
  const textures = new Map();
  const loadTexture = async (s) => {
    if (!textures.has(s.id)) {
      const tex = await new THREE.TextureLoader().loadAsync(`${base}${s.file}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textures.set(s.id, tex);
    }
    return textures.get(s.id);
  };
  const [buffer, texture] = await Promise.all([
    fetch(`${base}${meta.heightmap.file}`).then((r) => r.arrayBuffer()),
    loadTexture(initial),
  ]);
  const heights = new Float32Array(buffer);
  const { width: W, height: H, spacing } = meta.heightmap;
  const x0 = meta.minCellX * meta.cellUnits;
  const y0 = meta.minCellY * meta.cellUnits;

  const terrain = new THREE.Mesh(
    buildTerrainGeometry(heights, W, H, spacing, x0, y0, decimate),
    new THREE.MeshLambertMaterial({ map: texture }),
  );

  // Bilinear height lookup in Skyrim units (rows run south -> north).
  function heightAt(x, y) {
    const fx = Math.min(Math.max((x - x0) / spacing, 0), W - 1.001);
    const fy = Math.min(Math.max((y - y0) / spacing, 0), H - 1.001);
    const c = Math.floor(fx), r = Math.floor(fy), tx = fx - c, ty = fy - r;
    const h = (rr, cc) => heights[rr * W + cc];
    return (h(r, c) * (1 - tx) + h(r, c + 1) * tx) * (1 - ty) + (h(r + 1, c) * (1 - tx) + h(r + 1, c + 1) * tx) * ty;
  }

  const bounds = {
    minX: x0, minY: y0,
    maxX: x0 + meta.cellsX * meta.cellUnits, maxY: y0 + meta.cellsY * meta.cellUnits,
  };
  const water = buildWater(meta, bounds);
  let current = initial.id;

  // Swap the terrain texture and sea look; returns the style's scene look.
  async function setStyle(id) {
    const s = styles.find((st) => st.id === id) ?? styles[0];
    terrain.material.map = await loadTexture(s);
    const look = STYLE_LOOK[s.id] ?? STYLE_LOOK.terrain;
    water.material.color.set(look.water);
    water.material.opacity = look.waterOpacity;
    current = s.id;
    return { style: s, look };
  }

  return { meta, styles, terrain, water, heightAt, bounds, setStyle, get style() { return current; } };
}

function buildTerrainGeometry(heights, W, H, spacing, x0, y0, step) {
  const cols = Math.floor((W - 1) / step) + 1;
  const rows = Math.floor((H - 1) / step) + 1;
  const position = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hr = r * step, hc = c * step, i = r * cols + c;
      position[i * 3] = (x0 + hc * spacing) * SCALE;
      position[i * 3 + 1] = heights[hr * W + hc] * SCALE;
      position[i * 3 + 2] = -(y0 + hr * spacing) * SCALE;
      uv[i * 2] = hc / (W - 1);
      uv[i * 2 + 1] = hr / (H - 1);
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      index[k++] = a; index[k++] = b; index[k++] = d;
      index[k++] = b; index[k++] = e; index[k++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// Open sea at the worldspace's default water level. Lakes and rivers are already
// tinted into the color texture: per-cell water quads come out as blocky steps,
// because Skyrim sets river levels per cell and hides the seams with meshes.
function buildWater(meta, bounds) {
  const pad = 400000;
  const w = bounds.maxX - bounds.minX + pad * 2, h = bounds.maxY - bounds.minY + pad * 2;
  const geometry = new THREE.PlaneGeometry(w * SCALE, h * SCALE).rotateX(-Math.PI / 2);
  const material = new THREE.MeshPhongMaterial({
    color: 0x1d3f55, specular: 0x3d5866, shininess: 40, transparent: true, opacity: 0.82, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  toScene((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, meta.defaultWater, mesh.position);
  mesh.renderOrder = 1;
  return mesh;
}
