"""Write backend/app/pipeline/gl_transitions.json: the gl-transitions catalogue without the GLSL (docs/ENGINE.md §2).

    python scripts/dev/gen_gl_transitions.py                       # frontend/node_modules/gl-transitions, else `npm pack`
    python scripts/dev/gen_gl_transitions.py --src gl-transitions.json

The GPU engine runs the shaders from the npm package (gl-transitions 1.74.0, MIT). The backend only needs each
transition's name, label and params: fx.clean() validates "gl:<name>" transitions with them and GET /api/fx/catalog
lists them. Re-run after bumping the package, and commit the JSON.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

VERSION = "1.74.0"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "backend" / "app" / "pipeline" / "gl_transitions.json"
TYPES = {"float", "int", "bool", "vec2", "vec3", "vec4", "ivec2"}
RANGE = re.compile(r"@range\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*(?:,\s*([-+0-9.eE]+)\s*)?\)")
UNIFORM = re.compile(r"^\s*uniform\s+(\w+)\s+(\w+)\s*;")
# names that run words together or keep an acronym / typo the generic split can't see
LABELS = {
    "HSVfade": "HSV fade", "ZoomRigthWipe": "Zoom right wipe", "cannabisleaf": "Cannabis leaf", "squareswire": "Squares wire",
    "windowblinds": "Window blinds", "windowslice": "Window slice", "crosswarp": "Cross warp", "directionalwarp": "Directional warp",
    "directionalwipe": "Directional wipe", "fadecolor": "Fade colour", "fadegrayscale": "Fade greyscale", "colorphase": "Colour phase",
    "randomsquares": "Random squares", "randomNoisex": "Random noise X", "circleopen": "Circle open", "flyeye": "Fly eye",
    "old_tv_lost_signal": "Old TV lost signal", "burn0": "Burn 0",
}


def humanise(name: str) -> str:
    """"GlitchMemories" → "Glitch memories", "cube" → "Cube", "TVStatic" → "TV static", "Drop_Zone_Flicker" → "Drop zone flicker"."""
    if name in LABELS:
        return LABELS[name]
    s = re.sub(r"[_\-]+", " ", name)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    s = re.sub(r"([A-Za-z])(\d)", r"\1 \2", s)
    words = [w if len(w) > 1 and w.isupper() else w.lower() for w in s.split()]
    out = " ".join(words)
    return out[:1].upper() + out[1:]


def load(src: str | None) -> list[dict]:
    if src:
        return json.loads(Path(src).read_text(encoding="utf-8"))
    local = ROOT / "frontend" / "node_modules" / "gl-transitions" / "gl-transitions.json"
    if local.exists():
        print(f"reading {local}")
        return json.loads(local.read_text(encoding="utf-8"))
    npm = shutil.which("npm")
    if not npm:
        sys.exit("gl-transitions isn't installed in frontend/ and npm isn't on PATH: pass --src <gl-transitions.json>")
    with tempfile.TemporaryDirectory(prefix="gltr_") as tmp:
        print(f"npm pack gl-transitions@{VERSION}")
        subprocess.run([npm, "pack", f"gl-transitions@{VERSION}", "--ignore-scripts", "--silent"], cwd=tmp, check=True,
                       capture_output=True)
        tgz = next(Path(tmp).glob("gl-transitions-*.tgz"))
        with tarfile.open(tgz, "r:gz") as tar:  # read the one file, never extract the package
            f = tar.extractfile("package/gl-transitions.json")
            return json.load(io.TextIOWrapper(f, encoding="utf-8"))


def _ranges(glsl: str) -> dict[str, tuple[float, float, float | None]]:
    """{uniform: (min, max, step)} from `// @range(a, b[, step])` on the line before a uniform."""
    out: dict[str, tuple[float, float, float | None]] = {}
    lines = glsl.splitlines()
    for i, line in enumerate(lines[:-1]):
        m = RANGE.search(line)
        u = UNIFORM.match(lines[i + 1]) if m else None
        if m and u:
            out[u.group(2)] = (float(m.group(1)), float(m.group(2)), float(m.group(3)) if m.group(3) else None)
    return out


def _value(t: str, v):
    if t == "bool":
        return bool(v)
    if t == "int":
        return int(round(float(v)))
    if t == "float":
        return float(v)
    n = int(t[-1])
    vals = list(v)[:n]
    assert len(vals) == n, (t, v)
    return [int(round(float(x))) for x in vals] if t.startswith("i") else [float(x) for x in vals]


def entry(e: dict) -> dict:
    rng = _ranges(e.get("glsl") or "")
    meta = e.get("params") or {}
    params = []
    for name, t in (e.get("paramsTypes") or {}).items():
        if t not in TYPES:
            raise SystemExit(f"{e['name']}.{name}: unsupported uniform type {t}")
        m = meta.get(name) or {}
        p: dict = {"name": name, "type": t, "default": _value(t, (e.get("defaultParams") or {}).get(name, m.get("default")))}
        lo, hi, step = rng.get(name, (m.get("min"), m.get("max"), m.get("step")))
        if lo is not None and hi is not None and t != "bool":
            p["min"], p["max"] = float(lo), float(hi)
            if step:
                p["step"] = float(step)
        if m.get("color"):
            p["color"] = True
        if m.get("description"):
            p["description"] = str(m["description"])
        params.append(p)
    out = {"name": e["name"], "label": humanise(e["name"]), "tags": list(e.get("tags") or []), "author": e.get("author") or "",
           "license": e.get("license") or "MIT", "params": params, "needs_texture": bool(e.get("textures"))}
    if e.get("description"):
        out["description"] = str(e["description"])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", help="a gl-transitions.json to read (default: frontend/node_modules, else npm pack)")
    args = ap.parse_args()
    items = sorted((entry(e) for e in load(args.src)), key=lambda x: (x["label"].lower(), x["name"]))
    labels = [i["label"] for i in items]
    dupes = {lb for lb in labels if labels.count(lb) > 1}
    if dupes:
        sys.exit(f"duplicate labels: {sorted(dupes)}: add them to LABELS")
    OUT.write_text("[\n" + ",\n".join(json.dumps(i, ensure_ascii=False) for i in items) + "\n]\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(items)} transitions to {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
