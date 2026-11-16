"""Find game files the way Skyrim does: loose files beat archives, later mods beat
earlier ones, and only plugins active in your load order count.

Supports a plain/Vortex install (mods deployed into Data) and Mod Organizer 2
(mods live in MO2's own folders behind a virtual file system), including
Wabbajack lists that run from their own "Stock Game" / "Game Root" copy.
Built to stay fast on lists with thousands of mods.
"""
import os
import re
import struct
import winreg
from pathlib import Path

import lz4.frame

BASE_MASTERS = ["Skyrim.esm", "Update.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm"]


def find_data_dir():
    key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Bethesda Softworks\Skyrim Special Edition")
    return Path(winreg.QueryValueEx(key, "installed path")[0]) / "Data"


def norm(path):
    return path.lower().replace("/", "\\").strip("\\")


# --------------------------------------------------------------------------- BSA

def bsa_hash(name, is_folder=False):
    """The hash BSA archives store for folder and file names."""
    name = norm(name)
    stem, ext = (name, "") if is_folder else os.path.splitext(name)
    h = 0
    if stem:
        h = ord(stem[-1]) | (ord(stem[-2]) << 8 if len(stem) > 2 else 0) | (len(stem) << 16) | (ord(stem[0]) << 24)
    h |= {".kf": 0x80, ".nif": 0x8000, ".dds": 0x8080, ".wav": 0x80000000}.get(ext, 0)
    h2 = 0
    for c in stem[1:-2]:
        h2 = (h2 * 0x1003F + ord(c)) & 0xFFFFFFFF
    h3 = 0
    for c in ext:
        h3 = (h3 * 0x1003F + ord(c)) & 0xFFFFFFFF
    return (((h2 + h3) & 0xFFFFFFFF) << 32) | h


class Bsa:
    """Lazy reader for SSE BSA archives (version 105, LZ4).

    Opening reads only the folder table; a folder's file table is read the first
    time something in it is looked up. Lookups go by the archive's own hashes.
    """

    def __init__(self, path):
        self.path = Path(path)
        with open(path, "rb") as f:
            magic, version, _, flags, folders, _, _, self.names_len = struct.unpack("<4sIIIIIII", f.read(32))
            f.read(4)
            if magic != b"BSA\0" or version != 105:
                raise ValueError(f"{self.path.name}: unsupported BSA version {version}")
            table = f.read(24 * folders)
        self.compressed = bool(flags & 0x4)
        self.embed_names = bool(flags & 0x100)
        self.folders = {}
        for i in range(folders):
            folder_hash, count, _, offset = struct.unpack_from("<QIIQ", table, i * 24)
            self.folders[folder_hash] = (count, offset - self.names_len)
        self._files = {}

    def _folder_files(self, folder_hash):
        if folder_hash not in self._files:
            count, offset = self.folders[folder_hash]
            with open(self.path, "rb") as f:
                f.seek(offset)
                f.read(f.read(1)[0])  # folder name
                raw = f.read(16 * count)
            self._files[folder_hash] = {h: (size, off) for h, size, off in struct.iter_unpack("<QII", raw)}
        return self._files[folder_hash]

    def lookup(self, rel):
        folder, _, name = norm(rel).rpartition("\\")
        folder_hash = bsa_hash(folder, is_folder=True)
        if folder_hash not in self.folders:
            return None
        return self._folder_files(folder_hash).get(bsa_hash(name))

    def read(self, rel):
        entry = self.lookup(rel)
        if entry is None:
            return None
        size, offset = entry
        compressed = self.compressed != bool(size & 0x40000000)
        size &= 0x3FFFFFFF
        with open(self.path, "rb") as f:
            f.seek(offset)
            if self.embed_names:
                skip = f.read(1)[0]
                f.read(skip)
                size -= skip + 1
            if compressed:
                f.read(4)
                return lz4.frame.decompress(f.read(size - 4))
            return f.read(size)


# --------------------------------------------------------------------------- MO2

def _read_qt_ini(path):
    """MO2's ini is Qt-flavoured: values may be wrapped in @ByteArray(...)."""
    sections, current = {}, None
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            current = sections.setdefault(line[1:-1], {})
        elif "=" in line and current is not None:
            key, value = line.split("=", 1)
            match = re.fullmatch(r"@ByteArray\((.*)\)", value)
            current[key.strip()] = (match.group(1) if match else value).replace("\\\\", "\\")
    return sections


def locate_mo2_ini(path):
    """Accept an MO2 folder, a modlist/instance folder containing one, or the ini itself."""
    path = Path(path)
    if path.is_file():
        return path
    for candidate in [path / "ModOrganizer.ini", path / "MO2" / "ModOrganizer.ini", *path.glob("*/ModOrganizer.ini")]:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"No ModOrganizer.ini in {path}")


def _manages(ini, game_dir):
    game_path = _read_qt_ini(ini).get("General", {}).get("gamePath", "")
    try:
        return bool(game_path) and Path(game_path).resolve() == Path(game_dir).resolve()
    except OSError:
        return False


def find_setup(game_dir, mo2_dir=None):
    """Which MO2 instance (folder) runs the game in game_dir, or None for a plain/Vortex
    install. mo2_dir is where the running game's Mod Organizer lives (the SKSE plugin
    reports it): "" means the game wasn't started through MO2, None means unknown."""
    if mo2_dir == "":
        return None
    candidates = []
    if mo2_dir:
        candidates.append(Path(mo2_dir) / "ModOrganizer.ini")
    else:
        # Wabbajack lists keep MO2 next to their Stock Game / Game Root.
        for parent in list(Path(game_dir).parents)[:2]:
            try:
                candidates.append(locate_mo2_ini(parent))
            except FileNotFoundError:
                pass
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "ModOrganizer"
    candidates += root.glob("*/ModOrganizer.ini")  # global instances
    for ini in candidates:
        if ini.is_file() and _manages(ini, game_dir):
            return ini.parent
    return None


class Mo2:
    def __init__(self, path, profile=None):
        self.ini_path = locate_mo2_ini(path)
        ini = _read_qt_ini(self.ini_path)
        settings, general = ini.get("Settings", {}), ini.get("General", {})
        instance = self.ini_path.parent
        base = Path(settings.get("base_directory") or instance)

        def setting(key, default):
            value = settings.get(key)
            return Path(value.replace("%BASE_DIR%", str(base))) if value else base / default

        self.mods_dir = setting("mod_directory", "mods")
        self.overwrite = setting("overwrite_directory", "overwrite")
        profiles = setting("profiles_directory", "profiles")
        self.profile = profile or general.get("selected_profile", "Default")
        self.profile_dir = profiles / self.profile
        if not self.profile_dir.is_dir():
            raise FileNotFoundError(f"MO2 profile not found: {self.profile_dir}")
        self.profile_count = sum(1 for p in profiles.iterdir() if p.is_dir())
        self.game_dir = Path(general["gamePath"])
        # A portable instance in a folder literally called "MO2" is named after its parent.
        self.name = (instance.parent if instance.name.lower() == "mo2" else instance).name
        # modlist.txt lists the highest-priority mod first; "+" = enabled.
        lines = (self.profile_dir / "modlist.txt").read_text(encoding="utf-8", errors="replace").splitlines()
        self.enabled = [line[1:].strip() for line in lines if line.startswith("+")]


# --------------------------------------------------------------------------- virtual Data folder

class GameFS:
    def __init__(self, data_dir=None, mo2=None, profile=None):
        self.mo2 = Mo2(mo2, profile) if mo2 else None
        self.data_dir = Path(data_dir) if data_dir else (self.mo2.game_dir / "Data" if self.mo2 else find_data_dir())
        self.game_dir = self.data_dir.parent
        self.roots = [("Data", self.data_dir)]  # lowest -> highest priority
        self.plugins_txt = Path(os.environ["LOCALAPPDATA"]) / "Skyrim Special Edition" / "plugins.txt"
        self.manager = "Vortex / manual (Data folder)"
        if self.mo2:
            m = self.mo2
            self.roots += [(name, m.mods_dir / name) for name in reversed(m.enabled)]
            self.roots.append(("Overwrite", m.overwrite))
            self.plugins_txt = m.profile_dir / "plugins.txt"
            self.manager = f"Mod Organizer 2 ({m.name}, profile '{m.profile}', {len(m.enabled)} mods)"
        self._dirs = {}
        self.load_order = self._build_load_order()
        self.archives = self._build_archive_list()

    def _dir_index(self, reldir):
        """name -> (path, origin) for one Data-relative folder, merged across all mods."""
        index = self._dirs.get(reldir)
        if index is None:
            index = {}
            for origin, root in self.roots:  # later (higher priority) roots overwrite
                try:
                    with os.scandir(root / reldir if reldir else root) as entries:
                        for entry in entries:
                            if entry.is_file():
                                index[entry.name.lower()] = (Path(entry.path), origin)
                except (FileNotFoundError, NotADirectoryError):
                    pass
            self._dirs[reldir] = index
        return index

    def find_loose(self, rel):
        """Highest-priority loose copy of a Data-relative path, with the mod it came from."""
        folder, _, name = norm(rel).rpartition("\\")
        return self._dir_index(folder).get(name, (None, None))

    def read(self, rel):
        """(bytes, origin) for a Data-relative path, or (None, None) if the game has no such file."""
        path, origin = self.find_loose(rel)
        if path:
            return path.read_bytes(), origin
        for bsa in reversed(self.archives):  # later archives override earlier ones
            data = bsa.read(rel)
            if data is not None:
                return data, self.archive_origin.get(bsa.path, bsa.path.name)
        return None, None

    # ------------------------------------------------------------------ load order

    def _build_load_order(self):
        names = list(BASE_MASTERS)
        ccc = self.game_dir / "Skyrim.ccc"
        if ccc.is_file():
            names += [line.strip() for line in ccc.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
        if self.plugins_txt.is_file():
            for line in self.plugins_txt.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("*"):
                    names.append(line[1:].strip())
        seen, order = set(), []
        for name in names:
            path, origin = self.find_loose(name)
            if path and name.lower() not in seen:
                seen.add(name.lower())
                order.append((name, path, origin))
        # The game loads master-flagged plugins (ESM/ESL) before regular ones.
        return sorted(order, key=lambda entry: not _is_master(entry[1]))

    def _build_archive_list(self):
        self.archive_origin = {}
        paths = sorted(self.data_dir.glob("Skyrim - *.bsa"))
        for name, _, _ in self.load_order:
            stem = Path(name).stem
            for suffix in (".bsa", " - Textures.bsa"):
                path, origin = self.find_loose(stem + suffix)
                if path and path not in paths:
                    paths.append(path)
                    self.archive_origin[path] = origin
        archives = []
        for p in paths:
            try:
                archives.append(Bsa(p))
            except ValueError as exc:
                print(f"  skipping archive: {exc}")
        return archives


def _is_master(path):
    if path.suffix.lower() in (".esm", ".esl"):
        return True
    with open(path, "rb") as f:
        header = f.read(12)
    return len(header) == 12 and bool(struct.unpack_from("<I", header, 8)[0] & 0x1)
