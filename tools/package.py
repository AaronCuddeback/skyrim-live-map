"""Build the two Nexus downloads into dist/:

  SkyrimLiveMap-Plugin-<ver>.zip   the SKSE plugin, as a mod archive for MO2 / Vortex
  SkyrimLiveMap-App-<ver>.zip      the companion app: extract anywhere, run SkyrimLiveMap.exe

The app carries its own Node.js and a trimmed private Python (numpy, Pillow, lz4), so
players install nothing. Build the plugin first (see README); then, from the project:

    tools\\.venv\\Scripts\\python.exe tools\\package.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
# Staged outside the project: vcpkg-style deep paths and OneDrive-style sync both hate it there.
STAGE = Path(os.environ["LOCALAPPDATA"]) / "slm-pkg" / "release"
PLUGIN_DLL = Path(os.environ["LOCALAPPDATA"]) / "slm-build" / "build" / "Release" / "SkyrimLiveMap.dll"
VCVARS = Path(r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat")

# Standard library parts the tools never use.
STDLIB_SKIP = {"test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv", "lib2to3", "pydoc_data",
               "site-packages", "__pycache__", "unittest", "distutils", "msilib", "curses", "dbm", "sqlite3",
               "turtle.py", "pydoc.py", "doctest.py"}
DLLS_SKIP = re.compile(r"^(_tkinter|tcl|tk|_test|_sqlite3|sqlite3|_msi|_curses|xxlimited|_ctypes_test|winsound)", re.I)
SITE_PACKAGES = ("numpy", "numpy.libs", "PIL", "pillow.libs", "lz4")
NODE_MODULES = {"ws": None, "qrcode-terminal": None, "three": ("build", "examples/jsm", "LICENSE", "package.json")}


def version():
    cmake = (ROOT / "plugin" / "CMakeLists.txt").read_text(encoding="utf-8")
    return re.search(r"project\(SkyrimLiveMap VERSION ([\d.]+)", cmake).group(1)


def copytree(src, dst, ignore=()):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", *ignore), dirs_exist_ok=True)


def python_home():
    cfg = (ROOT / "tools" / ".venv" / "pyvenv.cfg").read_text(encoding="utf-8")
    return Path(re.search(r"^home = (.+)$", cfg, re.M).group(1).strip())


def build_python(dst):
    """A private, embeddable-style Python: the interpreter, the stdlib zipped as .pyc,
    extension modules, and just the packages the map tools import."""
    home = python_home()
    tag = f"python{sys.version_info.major}{sys.version_info.minor}"
    dst.mkdir(parents=True)
    for name in ("python.exe", f"{tag}.dll", "python3.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        shutil.copy2(home / name, dst / name)
    (dst / "DLLs").mkdir()
    for f in (home / "DLLs").iterdir():
        if f.suffix.lower() in (".pyd", ".dll") and not DLLS_SKIP.match(f.name):
            shutil.copy2(f, dst / "DLLs" / f.name)
    with zipfile.PyZipFile(dst / f"{tag}.zip", "w", zipfile.ZIP_DEFLATED, optimize=0) as z:
        for entry in sorted((home / "Lib").iterdir()):
            if entry.name in STDLIB_SKIP:
                continue
            if entry.is_dir() and (entry / "__init__.py").exists():
                z.writepy(entry, filterfunc=lambda p: not any(part in STDLIB_SKIP for part in Path(p).parts))
            elif entry.suffix == ".py":
                z.writepy(entry)
    site = dst / "Lib" / "site-packages"
    venv_site = ROOT / "tools" / ".venv" / "Lib" / "site-packages"
    for name in SITE_PACKAGES:
        if (venv_site / name).exists():
            copytree(venv_site / name, site / name, ignore=("tests", "testing"))
    for info in venv_site.glob("*.dist-info"):  # licenses travel with their package
        if info.name.split("-")[0].lower() in ("numpy", "pillow", "lz4"):
            copytree(info, site / info.name)
    # Like the official embeddable Python: exactly these paths, no site, no user folders.
    (dst / f"{tag}._pth").write_text("\n".join([f"{tag}.zip", "DLLs", r"Lib\site-packages", r"..\..\app\tools", ""]), encoding="ascii")


def build_launcher(dst, ver):
    src = ROOT / "launcher"
    work = STAGE.parent / "launcher"
    shutil.rmtree(work, ignore_errors=True)
    copytree(src, work)
    commas = ",".join((ver.split(".") + ["0"] * 4)[:4])
    (work / "version.h").write_text(f'#define SLM_VERSION "{ver}"\n#define SLM_VERSION_COMMAS {commas}\n', encoding="ascii")
    (work / "build.bat").write_text("\r\n".join([
        "@echo off",
        f'call "{VCVARS}" >nul || exit /b 1',
        "rc /nologo launcher.rc || exit /b 1",
        "cl /nologo /std:c++20 /O2 /MT /EHsc /W4 /WX /DUNICODE /D_UNICODE launcher.cpp launcher.res /Fe:SkyrimLiveMap.exe /link /SUBSYSTEM:CONSOLE",
    ]), encoding="ascii")
    subprocess.run(["cmd", "/c", str(work / "build.bat")], cwd=work, check=True)
    shutil.copy2(work / "SkyrimLiveMap.exe", dst / "SkyrimLiveMap.exe")


def node_exe():
    found = shutil.which("node")
    if not found:
        sys.exit("node.exe not found on PATH")
    return Path(found).resolve()


def zip_dir(folder, archive, prefix=""):
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                z.write(f, prefix + f.relative_to(folder).as_posix())


def main():
    ver = version()
    print(f"Skyrim Live Map {ver}")
    shutil.rmtree(STAGE, ignore_errors=True)
    DIST.mkdir(exist_ok=True)

    # ---- plugin: a mod archive with Data-relative paths
    if not PLUGIN_DLL.exists():
        sys.exit(f"Build the plugin first: {PLUGIN_DLL} is missing")
    plugin = STAGE / "plugin"
    (plugin / "SKSE" / "Plugins").mkdir(parents=True)
    shutil.copy2(PLUGIN_DLL, plugin / "SKSE" / "Plugins" / "SkyrimLiveMap.dll")
    shutil.copy2(ROOT / "plugin" / "SkyrimLiveMap.ini", plugin / "SKSE" / "Plugins" / "SkyrimLiveMap.ini")
    shutil.copy2(ROOT / "packaging" / "PLUGIN-NOTICES.txt", plugin / "SKSE" / "Plugins" / "SkyrimLiveMap-NOTICES.txt")
    plugin_zip = DIST / f"SkyrimLiveMap-Plugin-{ver}.zip"
    zip_dir(plugin, plugin_zip)

    # ---- companion app
    app = STAGE / "Skyrim Live Map"
    copytree(ROOT / "web", app / "app" / "web", ignore=("data",))
    copytree(ROOT / "tools", app / "app" / "tools", ignore=(".venv", "package.py"))
    server = app / "app" / "server"
    server.mkdir(parents=True)
    for name in ("server.js", "mapbuild.js"):
        shutil.copy2(ROOT / "server" / name, server / name)
    pkg = json.loads((ROOT / "server" / "package.json").read_text(encoding="utf-8"))
    pkg["version"] = ver
    pkg["scripts"] = {"start": "node server.js"}
    (server / "package.json").write_text(json.dumps(pkg, indent=2), encoding="utf-8")
    for name, parts in NODE_MODULES.items():
        src, dst = ROOT / "server" / "node_modules" / name, server / "node_modules" / name
        for part in parts or ("",):
            if (src / part).is_dir():
                copytree(src / part, dst / part)
            else:
                (dst / part).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src / part, dst / part)

    node_dir = app / "runtime" / "node"
    node_dir.mkdir(parents=True)
    shutil.copy2(node_exe(), node_dir / "node.exe")
    # The Windows installer ships no license file: Node's own, with a link to the full one.
    shutil.copy2(ROOT / "packaging" / "NODE-LICENSE.txt", node_dir / "LICENSE.txt")
    build_python(app / "runtime" / "python")
    build_launcher(app, ver)
    shutil.copy2(ROOT / "packaging" / "README.txt", app / "README.txt")
    shutil.copy2(ROOT / "packaging" / "APP-NOTICES.txt", app / "THIRD-PARTY-NOTICES.txt")

    # The private Python must actually work before this ships.
    check = subprocess.run([app / "runtime" / "python" / "python.exe", "-c",
                            "import numpy, PIL.Image, lz4.frame, esm, gamefs, nif, mapstyles, extract_map, localmap; print('python ok', numpy.__version__)"],
                           capture_output=True, text=True)
    print(check.stdout.strip() or check.stderr.strip())
    if check.returncode:
        sys.exit("bundled Python is broken")

    app_zip = DIST / f"SkyrimLiveMap-App-{ver}.zip"
    zip_dir(app, app_zip, "Skyrim Live Map/")
    for z in (plugin_zip, app_zip):
        print(f"{z.relative_to(ROOT)}  {z.stat().st_size / 1e6:.1f} MB")
    print(f"Unpacked app: {app}")


if __name__ == "__main__":
    main()
