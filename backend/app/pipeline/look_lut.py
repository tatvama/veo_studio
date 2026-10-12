"""Preset looks as 3D LUTs (docs/ENGINE.md §2), so the GPU engine applies exactly the server's look.

An identity HALD CLUT (`haldclutsrc=level=8`: 512×512 pixels holding 64³ colours, red fastest, then green, then blue)
goes through the look's own FFmpeg filter, is read back as 16-bit RGB, resampled to a 33-point cube (trilinear) and
written as standard .cube text. The looks are FFmpeg filters on video (YUV), so the HALD is turned into BT.709
limited-range 4:4:4 YUV first, as a decoded clip would be (Veo clips and Tatvam exports are BT.709).

Baked once per look and kept in storage at fx/looks/<look>.cube; its first line holds a hash of the look's filter
(and of this recipe), so a changed preset bakes again.
"""
from __future__ import annotations

import hashlib
import subprocess
import threading

from ..storage import get_storage
from . import ffmpeg as ff
from .fx import LOOKS

LEVEL = 8  # HALD level: LEVEL² = 64 entries per channel
N = LEVEL * LEVEL
SIZE = 33  # the .cube grid
RECIPE = "hald8-bt709-yuv444p-v1"  # change it when the bake changes: every cached cube bakes again
_lock = threading.Lock()


def look_key(look: str) -> str:
    return hashlib.sha1(f"{RECIPE}|{SIZE}|{LOOKS[look]['vf']}".encode()).hexdigest()[:16]


def hald_table(vf: str):
    """The look as a 64³ table, numpy float64 [b][g][r] → (r, g, b) in 0..1."""
    import numpy as np
    chain = f"haldclutsrc=level={LEVEL},format=gbrp16le"
    if vf:
        chain += f",scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,{vf}"
    p = subprocess.run([ff.ffmpeg_exe(), "-hide_banner", "-v", "error", "-f", "lavfi", "-i", f"{chain},format=rgb48le",
                        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"], capture_output=True, timeout=120)
    if p.returncode != 0 or len(p.stdout) != N ** 3 * 6:
        raise ff.FFmpegError(f"ffmpeg couldn't bake the look ({p.returncode}): {p.stderr.decode(errors='replace')[-400:]}")
    return (np.frombuffer(p.stdout, dtype="<u2").astype(np.float64) / 65535.0).reshape(N, N, N, 3)


def resample(table, size: int = SIZE):
    """A [b][g][r] table resampled to size³ points, trilinear (linear along each axis in turn)."""
    import numpy as np
    n = table.shape[0]
    pos = np.linspace(0.0, n - 1, size)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, n - 1)
    f = pos - i0
    t = table
    for axis in range(3):
        a, b = np.take(t, i0, axis=axis), np.take(t, i1, axis=axis)
        shape = [1, 1, 1, 1]
        shape[axis] = size
        t = a + (b - a) * f.reshape(shape)
    return np.clip(t, 0.0, 1.0)


def cube_text(look: str) -> str:
    """Bake a look as .cube text (LUT_3D_SIZE 33, red fastest)."""
    key = look_key(look)
    rows = resample(hald_table(LOOKS[look]["vf"])).reshape(-1, 3).tolist()
    head = [f"# tatvam-look {look} {key}", f"TITLE \"{LOOKS[look]['label']}\"", f"LUT_3D_SIZE {SIZE}",
            "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    return "\n".join(head + [f"{r:.5f} {g:.5f} {b:.5f}" for r, g, b in rows]) + "\n"


def cube(look: str) -> tuple[str, str]:
    """(.cube text, key) of a preset look: from storage, else baked now and stored. KeyError for an unknown look."""
    key = look_key(look)
    st = get_storage()
    rel = f"fx/looks/{look}.cube"
    first = f"# tatvam-look {look} {key}\n"

    def cached() -> str | None:
        if not st.exists(rel):
            return None
        text = st.abs(rel).read_text(encoding="utf-8")
        return text if text.startswith(first) else None

    text = cached()
    if text is None:
        with _lock:  # one bake at a time; a request that waited finds the cube ready
            text = cached()
            if text is None:
                text = cube_text(look)
                st.save_bytes(rel, text.encode("utf-8"))
    return text, key
