"""Reading plugin files (.esm/.esp/.esl) with FormIDs resolved across the load order.

A FormID's top byte indexes the plugin's own master list (or the plugin itself),
so 0x0000003C means "Tamriel" in any plugin whose first master is Skyrim.esm.
Every ID is resolved to (owning plugin, local ID) so overrides from different
plugins land on the same key.
"""
import mmap
import struct
import zlib
from pathlib import Path

DELETED = 0x20
COMPRESSED = 0x00040000
TOP_GROUPS = (b"WRLD", b"LTEX", b"TXST")
# Base objects whose models make up buildings and dungeons on the local map.
MODEL_TYPES = (b"STAT", b"MSTT", b"DOOR", b"FURN", b"CONT", b"ACTI", b"FLOR", b"SCOL")


def form_key(owner_local):
    """'plugin.esp:01ABCD': the id the SKSE plugin reports for the same form."""
    owner, local = owner_local
    return f"{owner}:{local:06X}"


def subrecords(data):
    i, big = 0, None
    while i < len(data):
        sig = data[i:i + 4]
        size = struct.unpack_from("<H", data, i + 4)[0]
        i += 6
        if sig == b"XXXX":
            big = struct.unpack_from("<I", data, i)[0]
            i += size
            continue
        if big is not None:
            size, big = big, None
        yield sig, data[i:i + size]
        i += size


def zstring(data):
    raw = data.split(b"\0", 1)[0]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


def parse_strings(raw):
    """A .STRINGS table: id -> text."""
    count, _ = struct.unpack_from("<II", raw, 0)
    base = 8 + count * 8
    table = {}
    for i in range(count):
        sid, off = struct.unpack_from("<II", raw, 8 + i * 8)
        end = raw.index(b"\0", base + off)
        table[sid] = raw[base + off:end].decode("utf-8", "replace")
    return table


class Plugin:
    def __init__(self, name, path):
        self.name = name
        self.key = name.lower()
        # Memory-mapped: only the groups we actually walk get read from disk.
        with open(path, "rb") as f:
            self.buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        sig, size, flags = struct.unpack_from("<4sII", self.buf, 0)
        if sig != b"TES4":
            self.close()
            raise ValueError(f"{name} is not a Skyrim plugin")
        self.localized = bool(flags & 0x80)
        self.masters = [zstring(d).lower() for s, d in subrecords(self.buf[24:24 + size]) if s == b"MAST"]
        self.body_start = 24 + size
        self._strings = None

    def resolve(self, form_id):
        index = form_id >> 24
        owner = self.masters[index] if index < len(self.masters) else self.key
        return owner, form_id & 0xFFFFFF

    def text(self, data, fs, lang):
        """A FULL-style field: a string-table ID in localized plugins, inline text otherwise."""
        if not self.localized:
            return zstring(data)
        if self._strings is None:
            raw, _ = fs.read(f"strings\\{Path(self.name).stem}_{lang}.strings")
            self._strings = parse_strings(raw) if raw else {}
        return self._strings.get(struct.unpack_from("<I", data)[0], "")

    def close(self):
        self.buf.close()

    def walk(self, visit, wanted, enter_world=lambda world: True, cell_group=None, top_groups=TOP_GROUPS):
        """Call visit(sig, form_id, flags, data, ctx) for records whose type is in `wanted`.

        ctx carries the resolved worldspace ("world") and parent cell ("cell")
        of the group the record sits in. Worldspaces for which enter_world()
        is false are skipped without reading them. cell_group(cell, pos, size, ctx),
        if given, sees every cell's children group (its placed objects) and returns
        whether to read inside it.
        """
        self.enter_world = enter_world
        self.cell_group = cell_group
        self.top_groups = top_groups
        self._walk(self.body_start, len(self.buf), visit, wanted, {})

    def records(self, pos, end):
        """Yield (sig, form_id, flags, data) for every record in a byte range, groups included."""
        buf = self.buf
        while pos < end:
            sig = buf[pos:pos + 4]
            size = struct.unpack_from("<I", buf, pos + 4)[0]
            if sig == b"GRUP":
                yield from self.records(pos + 24, pos + size)
                pos += size
                continue
            flags, form_id = struct.unpack_from("<II", buf, pos + 8)
            data = buf[pos + 24:pos + 24 + size]
            if flags & COMPRESSED:
                data = zlib.decompress(data[4:])
            yield sig, form_id, flags, data
            pos += 24 + size

    def _walk(self, pos, end, visit, wanted, ctx):
        buf = self.buf
        while pos < end:
            sig = buf[pos:pos + 4]
            size = struct.unpack_from("<I", buf, pos + 4)[0]
            if sig == b"GRUP":
                label = struct.unpack_from("<I", buf, pos + 8)[0]
                gtype = struct.unpack_from("<i", buf, pos + 12)[0]
                if gtype == 0 and buf[pos + 8:pos + 12] not in self.top_groups:
                    pos += size
                    continue
                child = ctx
                if gtype == 1:
                    world = self.resolve(label)
                    if not self.enter_world(world):
                        pos += size
                        continue
                    child = {**ctx, "world": world}
                elif gtype == 6 and self.cell_group and not self.cell_group(self.resolve(label), pos, size, ctx):
                    pos += size
                    continue
                if gtype in (6, 8, 9):
                    child = {**ctx, "cell": self.resolve(label)}
                self._walk(pos + 24, pos + size, visit, wanted, child)
                pos += size
                continue
            if sig in wanted:
                flags, form_id = struct.unpack_from("<II", buf, pos + 8)
                data = buf[pos + 24:pos + 24 + size]
                if flags & COMPRESSED:
                    data = zlib.decompress(data[4:])
                visit(sig, form_id, flags, data, ctx)
            pos += 24 + size
