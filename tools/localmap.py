"""Build local maps on demand: the walls, floors and buildings of one cell, from the
actual models your load order places there.

Interiors (dungeons, houses, inns) become a full layout; outdoor cells contribute
their buildings and walls to the 3D map. extract_map.py writes the index this reads
(localindex.json, models.json); results are cached in web/data/<map>/local/.

    python localmap.py --map nolvus-awakening --cell "skyrim.esm:01ABCD"
    python localmap.py --map nolvus-awakening --ext "skyrim.esm:00003C" 3 -2
    python localmap.py --serve     # worker for server.js: JSON requests on stdin, replies on stdout

Output per cell: <name>.bin.gz (triangles as uint16 x,y,z quantized into the bounds,
9 values per triangle) and <name>.json (name, bounds, triangle count, doors).
"""
import argparse
import gzip
import json
import math
import os
import struct
import sys
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

import esm
import gamefs
import nif

DATA_ROOT = Path(os.environ.get("SLM_DATA") or Path(__file__).resolve().parent.parent / "web" / "data")
INITIALLY_DISABLED = 0x800
MAX_TRIANGLES = 800_000  # big dungeons (Bleak Falls Temple ~534k) fit whole
SNAP = 28.0  # units (~40 cm): detail finer than this vanishes, walls and floors keep their shape
# Pure decoration: walk-through ("NoCol") pieces, vines, rubble piles, cobwebs, hanging stuff.
SKIP_DECORATION = ("nocol", "\\rubble\\", "vine", "cobweb", "web0", "hanging", "roots0", "decal")
SKIP_ALWAYS = ("marker", "effects\\", "fx\\", "sky\\", "magic\\", "water\\", "lod\\", "clutter\\fx")
SKIP_OUTDOORS = ("landscape\\", "plants\\", "trees\\", "clutter\\", "dlc01\\landscape", "dlc02\\landscape")
MIN_RADIUS = {"interior": 40.0, "exterior": 180.0}  # smaller models are clutter


def rotation(rx, ry, rz):
    """Skyrim reference rotation (radians) as a matrix: Gamebryo's X·Y·Z Euler order with
    clockwise-positive angles, i.e. Rx(-rx) @ Ry(-ry) @ Rz(-rz) in right-handed terms."""
    def rot(axis, a):
        c, s = math.cos(a), math.sin(a)
        if axis == "x":
            return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
        if axis == "y":
            return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    return rot("x", -rx) @ rot("y", -ry) @ rot("z", -rz)


def simplify(tris):
    """Snap vertices to a coarse grid and drop triangles that collapse: a top-down map
    doesn't need carvings and trim, and this cuts dense modern meshes several-fold."""
    snapped = np.round(tris / SNAP) * SNAP
    area = np.linalg.norm(np.cross(snapped[:, 1] - snapped[:, 0], snapped[:, 2] - snapped[:, 0]), axis=1)
    return snapped[area > 1e-3].astype(np.float32)


class Setup:
    """One extracted map's game files, index and parsed-model cache."""

    def __init__(self, map_id):
        datasets = json.loads((DATA_ROOT / "datasets.json").read_text(encoding="utf-8"))
        entry = next((d for d in datasets if d["id"] == map_id), None)
        if not entry or "source" not in entry:
            raise ValueError(f"map '{map_id}' has no local map index; re-run extract_map.py")
        source = entry["source"]
        self.out = DATA_ROOT / map_id / "local"
        self.fs = gamefs.GameFS(data_dir=None if source["mo2"] else source["data"], mo2=source["mo2"], profile=source["profile"])
        self.index = json.loads((DATA_ROOT / map_id / "localindex.json").read_text(encoding="utf-8"))
        self.models = json.loads((DATA_ROOT / map_id / "models.json").read_text(encoding="utf-8"))
        self.plugins = {}
        self.model_cache = OrderedDict()

    def plugin(self, index):
        if index not in self.plugins:
            name = self.index["plugins"][index]
            path, _ = self.fs.find_loose(name)
            self.plugins[index] = esm.Plugin(name, path) if path else None
        return self.plugins[index]

    def placed(self, groups):
        """Placed objects of one cell across the load order: key -> (base, pos, rot, scale, door)."""
        refs = {}
        for plugin_index, pos, size in groups:
            plugin = self.plugin(plugin_index)
            if plugin is None or pos + size > len(plugin.buf):
                continue
            for sig, form_id, flags, data in plugin.records(pos + 24, pos + size):
                if sig != b"REFR":
                    continue
                key = esm.form_key(plugin.resolve(form_id))
                if flags & (esm.DELETED | INITIALLY_DISABLED):
                    refs.pop(key, None)
                    continue
                base = place = None
                scale, door = 1.0, False
                for tag, value in esm.subrecords(data):
                    if tag == b"NAME":
                        base = esm.form_key(plugin.resolve(struct.unpack("<I", value)[0]))
                    elif tag == b"DATA" and len(value) >= 24:
                        place = struct.unpack_from("<6f", value)
                    elif tag == b"XSCL":
                        scale = struct.unpack("<f", value)[0]
                    elif tag == b"XTEL":
                        door = True
                if base and place:
                    refs[key] = (base, place[:3], place[3:], scale, door)
        return refs

    def model(self, path):
        """Model-space geometry and bounding radius, parsed once and kept (LRU)."""
        if path in self.model_cache:
            self.model_cache.move_to_end(path)
            return self.model_cache[path]
        raw, _ = self.fs.read("meshes\\" + path)
        parts, radius = [], 0.0
        if raw:
            try:
                parts = nif.geometry(raw)
                radius = max((float(np.linalg.norm(v, axis=1).max()) for v, _ in parts if len(v)), default=0.0)
            except Exception:  # noqa: BLE001 - an unreadable model just doesn't show
                parts = []
        self.model_cache[path] = (parts, radius)
        if len(self.model_cache) > 4000:
            self.model_cache.popitem(last=False)
        return parts, radius

    def build(self, refs, kind):
        doors, pieces = [], []
        for base, pos, rot, scale, door in refs.values():
            if door:
                doors.append([round(c) for c in pos])
            path = self.models.get(base)
            if not path:
                continue
            low = path.lower()
            if any(s in low for s in SKIP_ALWAYS + SKIP_DECORATION) or (kind == "exterior" and low.startswith(SKIP_OUTDOORS)):
                continue
            parts, radius = self.model(path)
            if not parts or radius * scale < MIN_RADIUS[kind]:
                continue
            # Rocks and boulders matter least for finding your way: they're trimmed first.
            rocky = "rock" in low or "boulder" in low
            pieces.append(((rocky, -radius * scale), parts, rotation(*rot) * scale, np.array(pos)))

        # Architecture first, then biggest first, so the triangle budget drops rocks and
        # clutter rather than walls and floors.
        pieces.sort(key=lambda p: p[0])
        triangles, total = [], 0
        for _, parts, matrix, pos in pieces:
            for verts, tris in parts:
                if total >= MAX_TRIANGLES:
                    break
                world = simplify((verts @ matrix.T + pos)[tris])
                triangles.append(world[:MAX_TRIANGLES - total])
                total += len(triangles[-1])
        return (np.concatenate(triangles) if triangles else np.zeros((0, 3, 3), np.float32)), doors

    def write(self, name, kind, title, triangles, doors):
        self.out.mkdir(parents=True, exist_ok=True)
        if len(triangles):
            flat = triangles.reshape(-1, 3)
            lo, hi = flat.min(0), flat.max(0)
        else:
            lo = hi = np.zeros(3, np.float32)
        span = np.maximum(hi - lo, 1e-3)
        quantized = np.round((triangles.reshape(-1, 3) - lo) / span * 65535).astype("<u2") if len(triangles) else np.zeros(0, "<u2")
        (self.out / f"{name}.bin.gz").write_bytes(gzip.compress(quantized.tobytes(), compresslevel=6))
        meta = {"name": title, "kind": kind, "bounds": [*map(float, lo), *map(float, hi)], "triangles": int(len(triangles)), "doors": doors}
        (self.out / f"{name}.json").write_text(json.dumps(meta), encoding="utf-8")
        return meta

    def interior(self, key):
        name = "i_" + key.replace(":", "_")
        cached = self.out / f"{name}.json"
        if cached.exists():
            return name, json.loads(cached.read_text(encoding="utf-8"))
        entry = self.index["interiors"].get(key)
        if not entry:
            raise KeyError(f"no interior {key} in this map's load order")
        triangles, doors = self.build(self.placed(entry["groups"]), "interior")
        return name, self.write(name, "interior", entry["name"], triangles, doors)

    def exterior(self, world, x, y):
        name = f"e_{world.replace(':', '_')}_{x}_{y}"
        cached = self.out / f"{name}.json"
        if cached.exists():
            return name, json.loads(cached.read_text(encoding="utf-8"))
        groups = self.index["exteriors"].get(f"{world}|{x}|{y}", [])
        triangles, doors = self.build(self.placed(groups), "exterior")
        return name, self.write(name, "exterior", "", triangles, doors)


def serve():
    """Worker loop for server.js: one JSON request per line in, one JSON reply per line out."""
    setups = {}
    for line in sys.stdin:
        try:
            req = json.loads(line)
            setup = setups.get(req["map"]) or setups.setdefault(req["map"], Setup(req["map"]))
            if req["kind"] == "interior":
                name, meta = setup.interior(req["key"])
            else:
                name, meta = setup.exterior(req["world"], int(req["x"]), int(req["y"]))
            reply = {"id": req.get("id"), "ok": True, "file": f"{req['map']}/local/{name}.bin.gz", "meta": meta}
        except Exception as exc:  # noqa: BLE001 - report, keep serving
            reply = {"id": req.get("id") if isinstance(req, dict) else None, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--map", help="map id from web/data/datasets.json")
    parser.add_argument("--cell", help="interior cell key, e.g. skyrim.esm:01ABCD")
    parser.add_argument("--ext", nargs=3, metavar=("WORLD", "X", "Y"), help="outdoor cell: worldspace key and grid")
    parser.add_argument("--serve", action="store_true", help="run as the server's worker")
    args = parser.parse_args()
    if args.serve:
        return serve()
    started = time.time()
    setup = Setup(args.map)
    name, meta = setup.interior(args.cell) if args.cell else setup.exterior(args.ext[0], int(args.ext[1]), int(args.ext[2]))
    print(f"{name}: {meta['name'] or 'outdoor cell'} - {meta['triangles']} triangles, {len(meta['doors'])} doors, "
          f"{(DATA_ROOT / args.map / 'local' / (name + '.bin.gz')).stat().st_size // 1024} KB, {time.time() - started:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
