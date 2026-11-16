"""Alternate map textures: a generated parchment map, and the game's own world map.

All grids here are full-resolution vertex grids (32 per cell) with row 0 at the
south edge, matching extract_map.py; images are returned north-up.
"""
import io
from collections import Counter

import numpy as np
from PIL import Image, ImageFilter

import nif

LOD_LEVEL = 32  # the LOD level the in-game world map renders
Image.MAX_IMAGE_PIXELS = None  # paper map textures are legitimately huge (8k+)

# sRGB DXGI formats Pillow doesn't know -> their identically-encoded linear twins.
_SRGB_TWIN = {29: 28, 72: 71, 75: 74, 78: 77, 99: 98, 91: 87, 93: 88}


def open_dds(raw):
    """Decode a DDS texture to RGB, including sRGB-flagged DX10 files."""
    if raw[84:88] == b"DX10" and len(raw) > 132:
        fmt = int.from_bytes(raw[128:132], "little")
        if fmt in _SRGB_TWIN:
            raw = raw[:128] + _SRGB_TWIN[fmt].to_bytes(4, "little") + raw[132:]
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _noise(shape, cells, rng):
    """Smooth value noise in [-1, 1]: random coarse grid upscaled with bicubic filtering."""
    h, w = shape
    coarse = rng.uniform(0, 255, (max(2, h // cells), max(2, w // cells))).astype(np.uint8)
    img = Image.fromarray(coarse).resize((w, h), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 127.5 - 1.0


def _blur(mask, radius):
    img = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(img, dtype=np.float32) / 255.0


def _mix(base, color, alpha):
    a = np.clip(alpha, 0, 1)[..., None]
    return base * (1 - a) + np.asarray(color, dtype=np.float32) * a


def parchment(heights, shade, water_depth, road, forest, snow, seed=7):
    """An old-paper map: sepia relief, contour lines, stippled forests, inked coasts and roads."""
    rng = np.random.default_rng(seed)
    shape = heights.shape
    paper = np.array((229, 211, 170), dtype=np.float32)

    # Paper: large stains, mid-scale mottling and fine grain.
    tone = 1 + 0.05 * _noise(shape, 220, rng) + 0.03 * _noise(shape, 40, rng) + 0.02 * rng.standard_normal(shape).astype(np.float32)
    img = paper * tone[..., None]

    water = water_depth > 0
    land = ~water

    # Relief as sepia ink wash.
    relief = np.clip(0.35 + 0.8 * shade, 0, 1.08)
    img = _mix(img, (120, 88, 55), (1 - relief) * 0.85 * land)
    img = _mix(img, (243, 236, 214), np.clip(snow, 0, 1) * 0.35 * land)

    # Forests: faint green-brown wash plus stipple dots.
    forest_mask = np.clip((forest - 0.35) * 2, 0, 1) * land
    img = _mix(img, (150, 150, 100), forest_mask * 0.25)
    dots = (rng.random(shape) < 0.07) & (forest_mask > 0.5)
    img = _mix(img, (78, 82, 48), dots * 0.55)

    # Contours every 1536 units (~22 m), every fifth one heavier.
    band = np.floor(heights / 1536).astype(np.int32)
    edge = np.zeros(shape, dtype=bool)
    edge[:, 1:] |= band[:, 1:] != band[:, :-1]
    edge[1:, :] |= band[1:, :] != band[:-1, :]
    index = edge & (band % 5 == 0)
    img = _mix(img, (98, 66, 38), (edge * 0.22 + index * 0.28) * land)

    # Water: faded blue-green, darker with depth, ripple lines off the coast.
    img[water] = _mix(img[water], (168, 184, 172), 0.75 + 0.2 * water_depth[water])
    land_f = land.astype(np.float32)
    for radius, level, strength in ((5, 0.22, 0.35), (12, 0.12, 0.22), (22, 0.07, 0.14)):
        near = _blur(land_f, radius)
        ripple = (np.abs(near - level) < 0.018) & water
        img = _mix(img, (82, 98, 96), ripple * strength)

    # Coastline and lake shores in ink.
    coast = np.zeros(shape, dtype=bool)
    coast[:, 1:] |= water[:, 1:] != water[:, :-1]
    coast[1:, :] |= water[1:, :] != water[:-1, :]
    coast = _blur(coast.astype(np.float32), 0.8) > 0.18
    img = _mix(img, (62, 48, 34), coast * 0.8)

    # Roads and paths: thin red-brown ink.
    road_mask = np.clip((road - 0.4) * 3, 0, 1) * land
    img = _mix(img, (128, 52, 34), road_mask * 0.85)

    # Darkened, worn edges.
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]].astype(np.float32)
    r = np.hypot((xx / shape[1] - 0.5) * 2, (yy / shape[0] - 0.5) * 2) / np.sqrt(2)
    img *= (1 - 0.45 * np.clip(r, 0, 1) ** 3)[..., None]

    return Image.fromarray(np.clip(img[::-1, :-1][:-1], 0, 255).astype(np.uint8))


def world_map(fs, min_x, min_y, cells_x, cells_y, max_px_per_cell=32):
    """The texture the in-game world map shows, as a north-up image over our cell grid.

    Flat World Map Framework paper maps drape one big texture via a flat mesh;
    everything else (vanilla, Quality World Map, generated LOD) uses LOD32 tiles.
    Returns (image, Counter of origins).
    """
    image, origins = flat_paper_map(fs, min_x, min_y, cells_x, cells_y, max_px_per_cell)
    if image is not None:
        return image, origins
    return lod_tiles(fs, min_x, min_y, cells_x, cells_y, max_px_per_cell)


def flat_paper_map(fs, min_x, min_y, cells_x, cells_y, max_px_per_cell=32, cell_units=4096):
    """FWMF-style map: find the quad in the world map mesh that covers the map, fit
    its UV -> world mapping, and resample its texture onto our grid."""
    raw, mesh_origin = fs.read(f"meshes\\terrain\\tamriel\\tamriel.{LOD_LEVEL}.0.0.btr")
    if raw is None:
        return None, Counter()
    try:
        shapes = list(nif.shapes(raw))
    except Exception as exc:
        print(f"  could not read world map mesh from {mesh_origin}: {exc}")
        return None, Counter()

    x0, y0 = min_x * cell_units, min_y * cell_units
    x1, y1 = (min_x + cells_x) * cell_units, (min_y + cells_y) * cell_units
    covering = [s for s in shapes if s["vertices"] <= 8 and s["texture"]
                and s["xy"][:, 0].min() <= x0 and s["xy"][:, 0].max() >= x1
                and s["xy"][:, 1].min() <= y0 and s["xy"][:, 1].max() >= y1]
    if not covering:
        return None, Counter()  # an ordinary terrain LOD mesh
    # The paper itself is the smallest quad covering the map (larger ones are backdrops).
    shape = min(covering, key=lambda s: np.ptp(s["xy"][:, 0]) * np.ptp(s["xy"][:, 1]))

    tex_path = shape["texture"].lower().replace("/", "\\")
    tex_path = tex_path[5:] if tex_path.startswith("data\\") else tex_path
    tex_path = tex_path if tex_path.startswith("textures\\") else "textures\\" + tex_path
    tex_raw, tex_origin = fs.read(tex_path)
    if tex_raw is None:
        print(f"  world map mesh points at missing texture {tex_path}")
        return None, Counter()
    texture = open_dds(tex_raw)

    # Least-squares affine fit: (x, y, 1) -> (u, v), then to texture pixels.
    xy, uv = shape["xy"], shape["uv"]
    design = np.c_[xy, np.ones(len(xy))]
    cu = np.linalg.lstsq(design, uv[:, 0], rcond=None)[0] * texture.width
    cv = np.linalg.lstsq(design, uv[:, 1], rcond=None)[0] * texture.height

    # Native resolution of the paper over our grid, capped.
    units_per_px = abs(np.ptp(xy[:, 0]) / texture.width)
    ppc = int(min(max(cell_units / units_per_px, 8), max_px_per_cell))
    step = cell_units / ppc
    # Output pixel (i, j): world x = x0 + (i + .5) * step, world y = y1 - (j + .5) * step.
    a, b = cu[0] * step, -cu[1] * step
    c = cu[0] * (x0 + step / 2) + cu[1] * (y1 - step / 2) + cu[2] - 0.5
    d, e = cv[0] * step, -cv[1] * step
    f = cv[0] * (x0 + step / 2) + cv[1] * (y1 - step / 2) + cv[2] - 0.5
    image = texture.transform((cells_x * ppc, cells_y * ppc), Image.AFFINE, (a, b, c, d, e, f), resample=Image.BICUBIC)
    return image, Counter({tex_origin: 1})


def lod_tiles(fs, min_x, min_y, cells_x, cells_y, max_px_per_cell=32):
    """Stitch the game's LOD32 terrain textures (vanilla / Quality World Map style)."""
    tiles, origins = {}, Counter()
    x0 = (min_x // LOD_LEVEL) * LOD_LEVEL
    y0 = (min_y // LOD_LEVEL) * LOD_LEVEL
    for tx in range(x0, min_x + cells_x, LOD_LEVEL):
        for ty in range(y0, min_y + cells_y, LOD_LEVEL):
            raw, origin = fs.read(f"textures\\terrain\\tamriel\\tamriel.{LOD_LEVEL}.{tx}.{ty}.dds")
            if raw is None:
                continue
            try:
                tiles[(tx, ty)] = open_dds(raw)
                origins[origin] += 1
            except Exception as exc:
                print(f"  could not decode LOD tile {tx},{ty} from {origin}: {exc}")
    if not tiles:
        return None, origins

    ppc = min(max(t.width for t in tiles.values()) // LOD_LEVEL, max_px_per_cell)
    tile_px = ppc * LOD_LEVEL
    canvas = Image.new("RGB", (cells_x * ppc, cells_y * ppc), (40, 44, 48))
    max_y = min_y + cells_y  # exclusive
    for (tx, ty), tile in tiles.items():
        if tile.width != tile_px:
            tile = tile.resize((tile_px, tile_px), Image.LANCZOS)
        # Tile image: top row = north edge of cells ty..ty+31, left = west edge of tx.
        canvas.paste(tile, ((tx - min_x) * ppc, (max_y - (ty + LOD_LEVEL)) * ppc))
    return canvas, origins
