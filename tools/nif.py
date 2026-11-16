"""Just enough NIF (Gamebryo 20.2.0.7, Skyrim LE and SE meshes) for two jobs:

- shapes(): the textured shapes of a world map .btr. Flat World Map Framework paper
  maps drape one big painted texture over the world with such a mesh, so its
  vertices + UVs tell us where it sits.
- geometry(): every renderable triangle of a model in model space, through the node
  hierarchy, for drawing building and dungeon layouts on the local map.
"""
import struct

import numpy as np


class Reader:
    def __init__(self, buf, pos=0):
        self.b, self.p = buf, pos

    def take(self, fmt):
        values = struct.unpack_from("<" + fmt, self.b, self.p)
        self.p += struct.calcsize("<" + fmt)
        return values if len(values) > 1 else values[0]

    def skip_counted(self, item_size, extra=0):
        """Skip a u32 count followed by count items of item_size bytes (plus extra bytes)."""
        count = self.take("I")
        self.p += count * item_size + extra

    def floats(self, n):
        arr = np.frombuffer(self.b, dtype="<f4", count=n, offset=self.p)
        self.p += 4 * n
        return arr


def _header(b):
    r = Reader(b, b.index(b"\n") + 1)
    version, _, _, num_blocks, bsver = r.take("IBIII")
    if version != 0x14020007:
        raise ValueError(f"unsupported NIF version {version:08x}")
    for _ in range(3):  # author, process script, export script
        r.p += 1 + b[r.p]
    if bsver >= 130:
        r.p += 1 + b[r.p]
    types = []
    for _ in range(r.take("H")):
        n = r.take("I")
        types.append(b[r.p:r.p + n].decode())
        r.p += n
    block_types = [types[t & 0x7FFF] for t in r.take(f"{num_blocks}H")] if num_blocks > 1 else [types[r.take("H") & 0x7FFF]]
    sizes = r.take(f"{num_blocks}I") if num_blocks > 1 else (r.take("I"),)
    num_strings, _ = r.take("II")
    for _ in range(num_strings):
        r.skip_counted(1)
    r.skip_counted(4)  # groups
    offsets, pos = [], r.p
    for size in sizes:
        offsets.append(pos)
        pos += size
    return bsver, block_types, offsets


def _av_object(r):
    """Common NiObjectNET/NiAVObject prefix: returns (translation, rotation 3x3, scale)."""
    r.take("i")                      # name
    r.skip_counted(4)                # extra data refs
    r.take("i")                      # controller
    r.take("I")                      # flags
    translation = np.array(r.take("3f"))
    rotation = np.array(r.take("9f")).reshape(3, 3)
    scale = r.take("f")
    r.take("i")                      # collision
    return translation, rotation, scale


def _tri_shape_data(b, pos):
    r = Reader(b, pos)
    r.take("i")                      # group id
    n = r.take("H")
    r.take("BB")                     # keep / compress flags
    verts = r.floats(n * 3).reshape(n, 3) if r.take("B") else None
    vector_flags = r.take("H")
    r.take("I")                      # material CRC
    if r.take("B"):                  # normals
        r.p += 12 * n
        if vector_flags & 0x1000:    # tangents + bitangents
            r.p += 24 * n
    r.p += 16                        # bound center + radius
    if r.take("B"):                  # vertex colors
        r.p += 16 * n
    uvs = r.floats(n * 2).reshape(n, 2) if vector_flags & 0x1 else None
    return verts, uvs


def _texture_path(b, pos):
    r = Reader(b, pos)
    if r.take("i") < 1:
        return ""
    n = r.take("I")
    return b[r.p:r.p + n].decode("cp1252", "replace")


# ------------------------------------------------------------------ geometry

LE_SHAPES = {"NiTriShape", "NiTriStrips", "BSLODTriShape"}
SE_SHAPES = {"BSTriShape", "BSSubIndexTriShape", "BSMeshLODTriShape"}
NOT_SOLID = {"BSEffectShaderProperty", "BSWaterShaderProperty", "BSSkyShaderProperty"}  # glow cards, water, sky
NO_TRIANGLES = np.zeros((0, 3), dtype=np.uint16)


def _geom_data(b, pos, strips):
    """Vertices and triangles from NiTriShapeData / NiTriStripsData."""
    r = Reader(b, pos)
    r.take("i")                      # group id
    n = r.take("H")
    r.take("BB")                     # keep / compress flags
    if not r.take("B"):
        return None, NO_TRIANGLES
    verts = r.floats(n * 3).reshape(n, 3)
    vector_flags = r.take("H")
    r.take("I")                      # material CRC
    if r.take("B"):                  # normals
        r.p += 12 * n
        if vector_flags & 0x1000:    # tangents + bitangents
            r.p += 24 * n
    r.p += 16                        # bound center + radius
    if r.take("B"):                  # vertex colors
        r.p += 16 * n
    r.p += (vector_flags & 0x1) * 8 * n  # UV set
    r.take("H")                      # consistency flags
    r.take("i")                      # additional data
    r.take("H")                      # num triangles
    if not strips:
        points = r.take("I")
        if not r.take("B"):
            return verts, NO_TRIANGLES
        return verts, np.frombuffer(b, dtype="<u2", count=points, offset=r.p).reshape(-1, 3)
    count = r.take("H")
    lengths = struct.unpack_from(f"<{count}H", b, r.p) if count else ()
    r.p += 2 * count
    if not r.take("B"):
        return verts, NO_TRIANGLES
    tris = []
    for length in lengths:
        pts = np.frombuffer(b, dtype="<u2", count=length, offset=r.p)
        r.p += 2 * length
        if length >= 3:
            t = np.stack([pts[:-2], pts[1:-1], pts[2:]], axis=1)
            tris.append(t[(t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])])  # drop degenerate joins
    return verts, np.concatenate(tris) if tris else NO_TRIANGLES


def _se_shape(b, r, bsver, block_types):
    """Vertices and triangles from a BSTriShape (vertex data packed per its descriptor)."""
    r.p += 16                        # bounding sphere
    skin, shader, _ = r.take("iii")  # skin, shader, alpha
    if skin >= 0 or (shader >= 0 and block_types[shader] in NOT_SOLID):
        return None, NO_TRIANGLES
    desc = r.take("Q")
    num_tris = r.take("I") if bsver >= 130 else r.take("H")
    num_verts = r.take("H")
    if r.take("I") == 0 or num_verts == 0:  # data size: 0 for skinned/partitioned meshes
        return None, NO_TRIANGLES
    vertex_size = (desc & 0xF) * 4
    attributes = desc >> 44
    raw = np.frombuffer(b, dtype=np.uint8, count=num_verts * vertex_size, offset=r.p).reshape(num_verts, vertex_size)
    r.p += num_verts * vertex_size
    if bsver < 130 or attributes & 0x400:  # SSE positions are always full precision
        verts = np.ascontiguousarray(raw[:, :12]).view("<f4").reshape(num_verts, 3)
    else:
        verts = np.ascontiguousarray(raw[:, :6]).view("<f2").reshape(num_verts, 3).astype(np.float32)
    tris = np.frombuffer(b, dtype="<u2", count=num_tris * 3, offset=r.p).reshape(-1, 3)
    return verts, tris


def _le_shape(b, r, block_types, offsets, kind):
    data_ref = r.take("i")
    skin = r.take("i")
    r.skip_counted(8)                # material names + extra data
    r.take("i")                      # active material
    r.take("B")                      # material needs update
    shader = r.take("i")
    if data_ref < 0 or skin >= 0 or (shader >= 0 and block_types[shader] in NOT_SOLID):
        return None, NO_TRIANGLES
    return _geom_data(b, offsets[data_ref], strips=block_types[data_ref] == "NiTriStripsData")


def geometry(b):
    """[(vertices Nx3, triangles Mx3)] for every solid shape, in model space.

    Walks the node tree from the root so each shape gets its parents' transforms.
    Skinned meshes and effect/water/sky shapes are skipped.
    """
    bsver, block_types, offsets = _header(b)
    out = []
    stack = [(0, np.zeros(3), np.eye(3), 1.0)]
    seen = set()
    while stack:
        i, t, rot, scale = stack.pop()
        if i in seen or not 0 <= i < len(block_types):
            continue
        seen.add(i)
        kind = block_types[i]
        is_node = kind.endswith("Node")
        if not (is_node or kind in LE_SHAPES or kind in SE_SHAPES):
            continue
        r = Reader(b, offsets[i])
        lt, lr, ls = _av_object(r)
        # Compose with the parent: p' = t + scale * rot @ (lt + ls * lr @ p).
        wt, wr, ws = t + scale * (rot @ lt), rot @ lr, scale * ls
        if is_node:
            count = r.take("I")
            for child in struct.unpack_from(f"<{count}i", b, r.p) if count else ():
                stack.append((child, wt, wr, ws))
            continue
        if kind in SE_SHAPES:
            verts, tris = _se_shape(b, r, bsver, block_types)
        else:
            verts, tris = _le_shape(b, r, block_types, offsets, kind)
        if verts is None or not len(tris) or tris.max() >= len(verts):
            continue
        out.append(((verts @ wr.T) * ws + wt, tris))
    return out


def shapes(b):
    """Yield dicts with world-space 'xy' vertices, 'uv', and 'texture' for each textured shape."""
    _, block_types, offsets = _header(b)
    for i, kind in enumerate(block_types):
        if kind != "NiTriShape":
            continue
        r = Reader(b, offsets[i])
        t, rot, scale = _av_object(r)
        data_ref = r.take("i")
        r.take("i")                  # skin instance
        r.skip_counted(8)            # material names + extra data
        r.take("i")                  # active material
        r.take("B")                  # material needs update
        shader_ref = r.take("i")
        if data_ref < 0 or shader_ref < 0 or block_types[shader_ref] != "BSLightingShaderProperty":
            continue
        verts, uvs = _tri_shape_data(b, offsets[data_ref])
        if verts is None or uvs is None:
            continue
        # BSLightingShaderProperty: shader type, name, extra data, controller, flags x2, uv offset/scale, texture set.
        s = Reader(b, offsets[shader_ref])
        s.take("Ii")
        s.skip_counted(4)
        s.take("iII")
        uv_offset, uv_scale = np.array(s.take("2f")), np.array(s.take("2f"))
        texset_ref = s.take("i")
        texture = _texture_path(b, offsets[texset_ref]) if texset_ref >= 0 else ""
        world = (verts @ rot.T) * scale + t
        yield {"xy": world[:, :2], "uv": uvs * uv_scale + uv_offset, "texture": texture, "vertices": len(verts)}
