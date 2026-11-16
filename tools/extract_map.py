"""Build the live map's terrain, map styles and markers from your Skyrim SE install.

Reads every active plugin in your load order (base game, DLC, Creation Club and
mods), so mod-added towns, locations and terrain edits show up on the map. Files
are resolved the way the game does, through Vortex deployments or Mod Organizer 2.

Each setup becomes its own map in web/data/<name>/ (listed in web/data/datasets.json):
  terrain-height.bin       heightmap for the 3D mesh
  terrain-color.jpg        realistic style, from the landscape textures
  terrain-paper.jpg        generated parchment style
  terrain-worldmap.jpg     the game's own world map (matches paper / world map mods)
  terrain.json, markers.json, loadorder.txt

    python extract_map.py                                    # plain Steam install
    python extract_map.py --mo2 "D:/NolvusV6/Instances/Nolvus Awakening" "D:/Modlists/SKNEM"
    python extract_map.py --mo2 "D:/Modlists/SKNEM" --profile "Kirbykings NSFW Edition"
    python extract_map.py --game "D:/Modlists/SKNEM/Game Root"   # whatever runs from there

The relay runs the --game form by itself when a game it has no map for connects.
SLM_DATA overrides where maps are written (default: web/data).
"""
import argparse
import json
import os
import re
import shutil
import struct
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

import esm
import gamefs
import mapstyles

DATA_ROOT = Path(os.environ.get("SLM_DATA") or Path(__file__).resolve().parent.parent / "web" / "data")
TAMRIEL = ("skyrim.esm", 0x3C)
MAP_MARKER = ("skyrim.esm", 0x10)
CELL_UNITS = 4096
VERTS = 33            # vertices per cell edge in a LAND record
STRIDE = 4            # heightmap decimation for the 3D mesh (512 units / ~7 m)
NO_WATER = 3.4e38
WANTED = {b"WRLD", b"TXST", b"LTEX", b"CELL", b"LAND", b"REFR", *esm.MODEL_TYPES}

MARKER_TYPES = {
    1: "City", 2: "Town", 3: "Settlement", 4: "Cave", 5: "Camp", 6: "Fort",
    7: "Nordic Ruin", 8: "Dwemer Ruin", 9: "Shipwreck", 10: "Grove",
    11: "Landmark", 12: "Dragon Lair", 13: "Farm", 14: "Wood Mill", 15: "Mine",
    16: "Imperial Camp", 17: "Stormcloak Camp", 18: "Standing Stone",
    19: "Wheat Farm", 20: "Smelter", 21: "Stable", 22: "Tower", 23: "Clearing",
    24: "Pass", 25: "Altar", 26: "Rock", 27: "Lighthouse", 28: "Orc Stronghold",
    29: "Giant Camp", 30: "Shack", 31: "Nordic Tower", 32: "Nordic Dwelling",
    33: "Docks", 34: "Shrine",
}
# 35..52 alternate hold capital "castle" (odd) and city (even) icons.
for _type in range(35, 53):
    MARKER_TYPES[_type] = "Capital" if _type % 2 == 0 else "Landmark"

# Extra channels painted alongside color, used by the parchment style.
CLASS_KEYWORDS = {"road": ("path", "cobble", "road"), "forest": ("forest", "pine"), "snow": ("snow",)}
CHANNELS = 3 + len(CLASS_KEYWORDS)


# --------------------------------------------------------------------------- load order merge

def collect(fs, lang):
    """Merge the records we need from every plugin, later plugins overriding earlier ones."""
    s = {"txst": {}, "ltex": {}, "cells": {}, "land": {}, "markers": {}, "parents": {}, "world": None,
         # For local maps: base object -> model, cell -> name/grid, and where each cell's
         # placed objects live in which plugin (read later, on demand).
         "models": {}, "cellinfo": {}, "interiors": {}, "exteriors": {}}
    contributions = []

    for plugin_index, (name, path, origin) in enumerate(fs.load_order):
        plugin = esm.Plugin(name, path)
        stats = Counter()

        def visit(sig, form_id, flags, data, ctx, plugin=plugin, stats=stats):
            key = plugin.resolve(form_id)
            if sig in esm.MODEL_TYPES:
                for tag, value in esm.subrecords(data):
                    if tag == b"MODL":
                        s["models"][esm.form_key(key)] = esm.zstring(value)
                        break
                return
            if sig == b"REFR":
                # Millions of placed objects; only map markers matter, and they all carry XMRK.
                if flags & esm.DELETED:
                    if s["markers"].pop(key, None):
                        stats["markers removed"] += 1
                    return
                if b"XMRK" not in data:
                    return
            subs = list(esm.subrecords(data))
            get = lambda tag: next((d for t, d in subs if t == tag), None)
            in_tamriel = ctx.get("world") == TAMRIEL

            if sig == b"WRLD":
                wnam = get(b"WNAM")
                s["parents"][key] = plugin.resolve(struct.unpack("<I", wnam)[0]) if wnam else None
                dnam = get(b"DNAM")
                if key == TAMRIEL and dnam:
                    land, water = struct.unpack_from("<ff", dnam)
                    s["world"] = {"defaultLand": land, "defaultWater": water}
            elif sig == b"TXST":
                tx = get(b"TX00")
                if tx:
                    s["txst"][key] = esm.zstring(tx)
            elif sig == b"LTEX":
                tnam = get(b"TNAM")
                s["ltex"][key] = {"edid": esm.zstring(get(b"EDID") or b""),
                                  "txst": plugin.resolve(struct.unpack("<I", tnam)[0]) if tnam else None}
            elif sig == b"CELL":
                info = s["cellinfo"].setdefault(key, {})
                world = ctx.get("world")
                info["world"] = world
                xclc = get(b"XCLC")
                if xclc and world is not None:
                    info["grid"] = struct.unpack_from("<ii", xclc)
                full = get(b"FULL")
                if full:
                    info["name"] = plugin.text(full, fs, lang)
                if in_tamriel and xclc:
                    x, y = struct.unpack_from("<ii", xclc)
                    xclw = get(b"XCLW")
                    s["cells"][key] = (x, y, struct.unpack("<f", xclw)[0] if xclw else None)
            elif sig == b"LAND" and in_tamriel:
                cell = s["cells"].get(ctx.get("cell"))
                if cell and not flags & esm.DELETED:
                    if (cell[0], cell[1]) in s["land"]:
                        stats["terrain edits"] += 1
                    s["land"][(cell[0], cell[1])] = (plugin, subs)
            elif sig == b"REFR":
                base = get(b"NAME")
                if not base or plugin.resolve(struct.unpack("<I", base)[0]) != MAP_MARKER or get(b"XMRK") is None:
                    return
                prev = s["markers"].get(key)
                full, tnam, pos = get(b"FULL"), get(b"TNAM"), struct.unpack_from("<fff", get(b"DATA"))
                stats["markers changed" if prev else "markers added"] += 1
                s["markers"][key] = {
                    "name": plugin.text(full, fs, lang) if full else (prev or {}).get("name", ""),
                    "type": tnam[0] if tnam else 0,
                    "world": ctx.get("world"),
                    "x": round(pos[0]), "y": round(pos[1]), "z": round(pos[2]),
                }

        def cell_group(cell, pos, size, ctx, plugin_index=plugin_index):
            """Note where this cell's placed objects live; read inside only outdoors."""
            world = ctx.get("world")
            if world is None:  # interior: its contents are only needed for its local map
                s["interiors"].setdefault(cell, []).append([plugin_index, pos, size])
                return False
            grid = s["cellinfo"].get(cell, {}).get("grid")
            if grid is not None:
                s["exteriors"].setdefault(f"{esm.form_key(world)}|{grid[0]}|{grid[1]}", []).append([plugin_index, pos, size])
            return True

        # Only Tamriel and the city worldspaces inside it share the map's coordinates.
        plugin.walk(visit, WANTED, enter_world=lambda w: w == TAMRIEL or s["parents"].get(w) == TAMRIEL,
                    cell_group=cell_group, top_groups=esm.TOP_GROUPS + (b"CELL",) + esm.MODEL_TYPES)
        if stats:
            contributions.append((name, origin, stats))
        plugin.close()  # LAND subrecords we kept are independent copies
    return s, contributions


# --------------------------------------------------------------------------- terrain

def decode_heights(vhgt):
    offset = struct.unpack_from("<f", vhgt)[0]
    grad = np.frombuffer(vhgt, dtype=np.int8, count=VERTS * VERTS, offset=4).reshape(VERTS, VERTS).astype(np.float32)
    # Row starts accumulate down column 0; each row then accumulates across.
    grad[:, 0] = np.cumsum(grad[:, 0])
    return (np.cumsum(grad, axis=1) + offset) * 8.0


KEYWORD_COLORS = [
    ("snow", (225, 230, 238)), ("ice", (200, 215, 230)), ("grass", (98, 110, 62)),
    ("tundra", (130, 120, 80)), ("rock", (110, 108, 102)), ("mountain", (120, 118, 112)),
    ("dirt", (110, 92, 70)), ("mud", (80, 70, 55)), ("sand", (170, 155, 120)),
    ("road", (125, 112, 95)), ("forest", (70, 80, 50)), ("needle", (85, 72, 55)),
]


def build_palette(fs, s):
    """Per landscape texture: average color from its DDS (through mods) + class channels."""
    cache = {}
    sampled = 0
    for key, info in s["ltex"].items():
        tex = s["txst"].get(info["txst"])
        words = (info["edid"] + " " + (tex or "")).lower()
        color = None
        if tex:
            raw, _ = fs.read("textures\\" + tex)
            if raw:
                try:
                    img = mapstyles.open_dds(raw)
                    color = np.asarray(img.resize((16, 16), Image.BOX), dtype=np.float32).reshape(-1, 3).mean(0)
                    sampled += 1
                except Exception as exc:
                    print(f"  could not decode {tex}: {exc}")
        if color is None:
            color = next((np.array(c, np.float32) for w, c in KEYWORD_COLORS if w in words), np.array((105, 100, 85), np.float32))
        classes = [1.0 if any(k in words for k in kws) else 0.0 for kws in CLASS_KEYWORDS.values()]
        cache[key] = np.concatenate([color, np.array(classes, np.float32)])
    print(f"  {sampled}/{len(s['ltex'])} landscape textures sampled from DDS")
    default = np.array((112, 96, 74) + (0,) * len(CLASS_KEYWORDS), np.float32)  # LandscapeDefault dirt
    return lambda key: cache.get(key, default), default


def paint_cell(plugin, subs, palette, default):
    """Blend the base and alpha texture layers of one LAND record into 33x33 color+class values."""
    out = np.empty((VERTS, VERTS, CHANNELS), dtype=np.float32)
    out[:] = default
    layers, current = [], None
    for sig, data in subs:
        if sig == b"BTXT":
            form_id, quad = struct.unpack_from("<IB", data)
            r0, c0 = (quad // 2) * 16, (quad % 2) * 16
            out[r0:r0 + 17, c0:c0 + 17] = palette(plugin.resolve(form_id))
        elif sig == b"ATXT":
            form_id, quad, _, layer = struct.unpack_from("<IBBH", data)
            current = [quad, layer, palette(plugin.resolve(form_id)), np.zeros((17, 17), dtype=np.float32)]
            layers.append(current)
        elif sig == b"VTXT" and current is not None:
            entries = np.frombuffer(data, dtype=[("pos", "<u2"), ("pad", "<u2"), ("op", "<f4")])
            pos = np.minimum(entries["pos"], 288)
            current[3][pos // 17, pos % 17] = np.clip(entries["op"], 0, 1)
    for quad, _, value, alpha in sorted(layers, key=lambda layer: (layer[0], layer[1])):
        r0, c0 = (quad // 2) * 16, (quad % 2) * 16
        block = out[r0:r0 + 17, c0:c0 + 17]
        block[:] = block * (1 - alpha[..., None]) + value * alpha[..., None]
    vclr = next((d for s, d in subs if s == b"VCLR"), None)
    if vclr is not None:
        out[..., :3] *= np.frombuffer(vclr, dtype=np.uint8, count=VERTS * VERTS * 3).reshape(VERTS, VERTS, 3) / 255.0
    return out


def build_terrain(s, palette, default):
    xs = [x for x, _ in s["land"]]
    ys = [y for _, y in s["land"]]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    cells_x, cells_y = max_x - min_x + 1, max_y - min_y + 1
    full_w, full_h = cells_x * 32 + 1, cells_y * 32 + 1
    print(f"  cell range x {min_x}..{max_x}, y {min_y}..{max_y} -> {full_w}x{full_h} vertices")

    world = s["world"]
    heights = np.full((full_h, full_w), world["defaultLand"], dtype=np.float32)
    paint = np.empty((full_h, full_w, CHANNELS), dtype=np.float32)
    paint[:] = default
    for (x, y), (plugin, subs) in s["land"].items():
        vhgt = next((d for t, d in subs if t == b"VHGT"), None)
        if vhgt is None:
            continue
        r, c = (y - min_y) * 32, (x - min_x) * 32
        heights[r:r + VERTS, c:c + VERTS] = decode_heights(vhgt)
        paint[r:r + VERTS, c:c + VERTS] = paint_cell(plugin, subs, palette, default)

    water = np.full((cells_y, cells_x), world["defaultWater"], dtype=np.float32)  # unloaded cells are open sea
    for x, y, level in s["cells"].values():
        if min_x <= x <= max_x and min_y <= y <= max_y and level is not None:
            # XCLW: FLT_MAX = world default sea level; ~4.29e9 = no water at all.
            if level >= NO_WATER:
                continue
            water[y - min_y, x - min_x] = np.nan if level > 1e9 else level
    grid = {"minX": min_x, "minY": min_y, "cellsX": cells_x, "cellsY": cells_y}
    return grid, heights, paint, water


def realistic(heights, paint, depth):
    """Landscape-texture colors with baked hillshade and depth-tinted water."""
    colors = paint[..., :3].copy()
    colors *= (0.55 + 0.6 * hillshade(heights))[..., None]
    submerged = depth > 0
    water_rgb = np.array((38, 70, 92), dtype=np.float32)
    k = (0.55 + 0.4 * depth[submerged])[:, None]
    colors[submerged] = colors[submerged] * (1 - k) + water_rgb * k
    return Image.fromarray(np.clip(colors[::-1, :-1][:-1], 0, 255).astype(np.uint8))


def hillshade(heights):
    # Sun from the north-west, at full resolution: the 3D mesh is decimated and
    # would otherwise lose small-scale relief.
    gy, gx = np.gradient(heights, 128.0)
    normal = np.dstack((-gx, -gy, np.ones_like(gx)))
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    sun = np.array((-0.5, 0.5, 0.7))
    return np.clip(normal @ (sun / np.linalg.norm(sun)), 0, 1).astype(np.float32)


# --------------------------------------------------------------------------- main

def extract(fs, out, lang):
    """Build one map dataset (terrain, styles, markers) into `out`. Returns its summary."""
    started = time.time()
    out.mkdir(parents=True, exist_ok=True)
    print(f"Game: {fs.game_dir}")
    print(f"Mods: {fs.manager}")
    print(f"Load order: {len(fs.load_order)} active plugins, {len(fs.archives)} archives")

    print("Reading plugins ...")
    s, contributions = collect(fs, lang)
    shown = 0
    for name, origin, stats in contributions:
        if shown < 40 or "markers added" in stats:
            detail = ", ".join(f"{v} {k}" for k, v in stats.items())
            print(f"  {name:<44} {detail}" + (f"   [{origin}]" if origin != "Data" else ""))
            shown += 1
    if len(contributions) > shown:
        print(f"  ... and {len(contributions) - shown} more plugins with terrain edits")

    print("Building terrain ...")
    palette, default = build_palette(fs, s)
    grid, heights, paint, water = build_terrain(s, palette, default)
    water_full = np.kron(np.nan_to_num(water, nan=-1e9), np.ones((32, 32), dtype=np.float32))
    water_full = np.pad(water_full, ((0, 1), (0, 1)), mode="edge")
    depth = np.clip((water_full - heights) / 2500.0, 0, 1)

    styles = []
    realistic(heights, paint, depth).save(out / "terrain-color.jpg", quality=88)
    styles.append({"id": "terrain", "label": "Terrain", "file": "terrain-color.jpg"})

    print("Drawing parchment map ...")
    cls = {name: paint[..., 3 + i] for i, name in enumerate(CLASS_KEYWORDS)}
    mapstyles.parchment(heights, hillshade(heights), depth, cls["road"], cls["forest"], cls["snow"]).save(out / "terrain-paper.jpg", quality=88)
    styles.append({"id": "paper", "label": "Parchment", "file": "terrain-paper.jpg"})

    print("Rendering the in-game world map ...")
    wm, origins = mapstyles.world_map(fs, grid["minX"], grid["minY"], grid["cellsX"], grid["cellsY"])
    if wm:
        wm.save(out / "terrain-worldmap.jpg", quality=90)
        modded = sorted({o for o in origins if not o.lower().startswith("skyrim - ")})
        source = ", ".join(modded) if modded else "Vanilla"
        styles.append({"id": "worldmap", "label": "World Map", "file": "terrain-worldmap.jpg", "source": source})
        print(f"  {wm.width}x{wm.height} from {source}")
    else:
        print("  no world map texture found; skipping")

    small = heights[::STRIDE, ::STRIDE].astype("<f4")
    small.tofile(out / "terrain-height.bin")

    print("Collecting map markers ...")
    display = {name.lower(): name for name, _, _ in fs.load_order}
    creation_club = {name.lower() for name, _, _ in fs.load_order if name.lower().startswith("cc")}
    base_game = {name.lower() for name in gamefs.BASE_MASTERS}
    markers = []
    for (owner, local_id), m in s["markers"].items():
        ws = m.pop("world")
        # Walled cities live in child worldspaces that share Tamriel's coordinates.
        if ws != TAMRIEL and s["parents"].get(ws) != TAMRIEL:
            continue
        if not m["name"]:
            continue
        entry = {**m, "id": f"{owner}:{local_id:06X}", "kind": MARKER_TYPES.get(m["type"], "Location"), "inCity": ws != TAMRIEL}
        if owner in creation_club:
            entry["source"] = "Creation Club"
        elif owner not in base_game:
            entry["source"] = display.get(owner, owner)
        markers.append(entry)
    load_index = {name.lower(): i for i, (name, _, _) in enumerate(fs.load_order)}
    before = len(markers)
    markers = sorted(dedupe(markers, load_index), key=lambda m: m["name"])
    if before > len(markers):
        print(f"  merged {before - len(markers)} duplicate markers")

    meta = {
        "worldspace": "Tamriel",
        "cellUnits": CELL_UNITS,
        "minCellX": grid["minX"], "minCellY": grid["minY"], "cellsX": grid["cellsX"], "cellsY": grid["cellsY"],
        "heightmap": {"file": "terrain-height.bin", "width": small.shape[1], "height": small.shape[0],
                      "spacing": 128 * STRIDE, "rowOrder": "south-to-north"},
        "styles": styles,
        "heightRange": [float(heights.min()), float(heights.max())],
        "defaultWater": s["world"]["defaultWater"],
        "modManager": fs.manager,
    }
    (out / "terrain.json").write_text(json.dumps(meta))
    (out / "markers.json").write_text(json.dumps(markers, ensure_ascii=False))
    (out / "loadorder.txt").write_text("\n".join(name for name, _, _ in fs.load_order), encoding="utf-8")

    # Local map index: read by tools/localmap.py when a cell's map is first requested.
    interiors = {}
    for cell, groups in s["interiors"].items():
        interiors[esm.form_key(cell)] = {"name": s["cellinfo"].get(cell, {}).get("name", ""), "groups": groups}
    local_index = {"plugins": [name for name, _, _ in fs.load_order], "interiors": interiors, "exteriors": s["exteriors"]}
    (out / "localindex.json").write_text(json.dumps(local_index, separators=(",", ":")), encoding="utf-8")
    (out / "models.json").write_text(json.dumps(s["models"], separators=(",", ":")), encoding="utf-8")
    shutil.rmtree(out / "local", ignore_errors=True)  # cached local maps may be stale now
    print(f"  local map index: {len(interiors)} interiors, {len(s['exteriors'])} outdoor cells, {len(s['models'])} models")
    kinds = Counter("mods" if m.get("source") not in (None, "Creation Club") else (m.get("source") or "base game") for m in markers)
    print(f"Done in {time.time() - started:.0f}s: {len(markers)} markers ({', '.join(f'{v} {k}' for k, v in kinds.most_common())})")
    return {"markers": len(markers), "modMarkers": kinds.get("mods", 0), "plugins": len(fs.load_order),
            "styles": [st["label"] + (f" ({st['source']})" if st.get("source") else "") for st in styles]}


DUPLICATE_RADIUS = 1500  # units (~21 m): same-named markers this close are one place


def dedupe(markers, load_index):
    """Collapse markers that mark the same place twice: mods re-marking a spot another
    mod (or the game) already marks, plugins shipping copies, quest-state twins like the
    Imperial/Stormcloak camps. The copy from the earliest plugin in the load order wins."""
    by_name, kept = {}, []
    for m in sorted(markers, key=lambda m: (load_index.get(m["id"].split(":")[0], len(load_index)), m["inCity"])):
        twins = by_name.setdefault(m["name"].lower(), [])
        if any(abs(t["x"] - m["x"]) < DUPLICATE_RADIUS and abs(t["y"] - m["y"]) < DUPLICATE_RADIUS for t in twins):
            continue
        twins.append(m)
        kept.append(m)
    return kept


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "map"


def norm_game_path(path):
    """How the web app compares the game folder the SKSE plugin reports."""
    return str(Path(path)).replace("\\", "/").rstrip("/").lower()


def update_index(root, entry):
    """web/data/datasets.json: every extracted map, so the app can switch between them."""
    index_path = root / "datasets.json"
    try:
        datasets = json.loads(index_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        datasets = []
    datasets = [d for d in datasets if d["id"] != entry["id"]] + [entry]
    index_path.write_text(json.dumps(sorted(datasets, key=lambda d: d["name"].lower()), indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mo2", type=Path, nargs="+", metavar="FOLDER",
                        help="one or more Mod Organizer 2 instances / Wabbajack modlist folders")
    parser.add_argument("--profile", help="MO2 profile (default: each instance's selected profile)")
    parser.add_argument("--name", help="display name for the map (default: from the instance/profile)")
    parser.add_argument("--vanilla", action="store_true", help="also build the plain Steam install's map")
    parser.add_argument("--data", type=Path, help="Skyrim SE Data folder for the plain install (default: registry)")
    parser.add_argument("--game", type=Path, metavar="FOLDER",
                        help="build the map for the setup that runs the game in this folder (MO2 or plain)")
    parser.add_argument("--mo2-dir", metavar="FOLDER",
                        help="with --game: the folder of the Mod Organizer that launched it ('' = not MO2)")
    parser.add_argument("--out", type=Path, default=DATA_ROOT, help="root folder for map datasets (default: web/data)")
    parser.add_argument("--lang", default="english", help="language of localized strings (default: english)")
    args = parser.parse_args()

    targets = [("mo2", p) for p in args.mo2 or []]
    if args.game:
        instance = gamefs.find_setup(args.game, args.mo2_dir)
        print(f"Game folder {args.game}: " + (f"Mod Organizer 2 instance {instance}" if instance else "no mod manager / Vortex"))
        targets = [("mo2", instance)] if instance else [("vanilla", None)]
        args.data = args.data or (None if instance else args.game / "Data")
    elif args.vanilla or not targets:
        targets.insert(0, ("vanilla", None))

    for kind, path in targets:
        fs = gamefs.GameFS(mo2=path, profile=args.profile) if kind == "mo2" else gamefs.GameFS(data_dir=args.data)
        if fs.mo2:
            m = fs.mo2
            single = m.profile_count == 1 or m.profile.lower() == m.name.lower()
            name = args.name or (m.name if single else f"{m.name} · {m.profile}")
        else:
            name = args.name or "Skyrim (no mod manager)"
        dataset_id = slug(name)
        print(f"\n=== {name}  ->  data/{dataset_id}/")
        summary = extract(fs, args.out / dataset_id, args.lang)
        update_index(args.out, {
            "id": dataset_id, "name": name, "gamePath": norm_game_path(fs.game_dir),
            "manager": fs.manager, "updated": time.strftime("%Y-%m-%d %H:%M"), **summary,
            # How tools/localmap.py finds this setup's files again.
            "source": {"mo2": str(fs.mo2.ini_path) if fs.mo2 else None, "profile": fs.mo2.profile if fs.mo2 else None,
                       "data": str(fs.data_dir)},
        })
    print(f"\nMaps: {args.out / 'datasets.json'}")


if __name__ == "__main__":
    sys.exit(main())


