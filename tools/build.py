#!/usr/bin/env python3
"""Build a deterministic XPI and a Zotero update manifest without dependencies."""

import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
addon = root / "addon"
manifest = json.loads((addon / "manifest.json").read_text())
assert (
    manifest["version"] == json.loads((root / "package.json").read_text())["version"]
), "Package version mismatch"
for path in addon.rglob("*.xhtml"):
    ET.parse(path)
version = manifest["version"]
runtime = json.loads((root / "engine/runtime.json").read_text())
runtime_digest = hashlib.sha256(
    (root / "engine/pyproject.toml").read_bytes()
    + (root / "engine/uv.lock").read_bytes()
    + runtime["python"].encode()
).hexdigest()
assert runtime["id"] == runtime_digest[:16], (
    "Runtime identity must match its dependency lock and Python pin"
)
destination = root / "dist"
destination.mkdir(exist_ok=True)
xpi = destination / f"zotero-local-translate-{version}.xpi"
files = {
    p.relative_to(addon).as_posix(): p
    for p in addon.rglob("*")
    if p.is_file() and "__pycache__" not in p.parts
}
files.update(
    {
        "content/" + p.relative_to(root / "src").as_posix(): p
        for p in (root / "src").rglob("*.js")
    }
)
files.update(
    {
        "worker/" + name: root / "engine" / name
        for name in ("worker.py", "pyproject.toml", "uv.lock", "runtime.json")
    }
)
for relative, path in files.items():
    relative = Path(relative)
    if not (
        relative.as_posix()
        in {
            "bootstrap.js",
            "manifest.json",
            "worker/worker.py",
            "worker/pyproject.toml",
            "worker/uv.lock",
            "worker/runtime.json",
        }
        or (
            relative.parts[0] == "content"
            and relative.suffix in {".js", ".css", ".xhtml", ".svg", ".png"}
        )
    ):
        raise SystemExit(f"Unexpected file in XPI: {relative}")
    data = path.read_bytes()
    if re.search(rb"sk-[A-Za-z0-9_-]{16,}", data):
        raise SystemExit(f"Possible API credential in package: {path.name}")
    for resource in re.findall(
        rb'chrome://localtranslate/content/([^\s"\')<>]+)', data
    ):
        if "content/" + resource.decode() not in files:
            raise SystemExit(
                f"Missing chrome resource in {relative}: {resource.decode()}"
            )
for icon in manifest.get("icons", {}).values():
    if not (addon / icon).is_file():
        raise SystemExit(f"Missing manifest icon: {icon}")
with ZipFile(xpi, "w", ZIP_DEFLATED) as archive:
    for name, path in sorted(files.items()):
        entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o644 << 16
        archive.writestr(entry, path.read_bytes())
digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
updates = {
    "addons": {
        manifest["applications"]["zotero"]["id"]: {
            "updates": [
                {
                    "version": version,
                    "update_link": f"https://github.com/liuwenbo0/zotero-local-translate/releases/download/v{version}/{xpi.name}",
                    "update_hash": "sha256:" + digest,
                    "applications": {
                        "zotero": {
                            "strict_min_version": "10.0",
                            "strict_max_version": "10.0.*",
                        }
                    },
                }
            ]
        }
    }
}
(destination / "updates.json").write_text(json.dumps(updates, indent=2) + "\n")
(destination / "SHA256SUMS").write_text(f"{digest}  {xpi.name}\n")
print(f"Built {xpi}\nSHA256 {digest}")
