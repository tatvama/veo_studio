"""Captions: SRT + styled ASS (burned in by FFmpeg/libass, HarfBuzz shaping works for Indic scripts)."""
from __future__ import annotations

from pathlib import Path

Cue = tuple[float, float, str]


def chunk_text(text: str, max_chars: int = 30) -> list[str]:
    words = text.replace("\n", " ").split()
    chunks, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > max_chars:
            chunks.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        chunks.append(cur)
    return chunks or [text]


def cues_for(start: float, end: float, text: str, max_chars: int = 30) -> list[Cue]:
    chunks = chunk_text(text, max_chars)
    total = sum(len(c) for c in chunks) or 1
    out, t = [], start
    for c in chunks:
        d = (end - start) * len(c) / total
        out.append((round(t, 3), round(t + d, 3), c))
        t += d
    return out


def _ts_srt(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def _ts_ass(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


def write_srt(cues: list[Cue], path: Path) -> Path:
    lines = []
    for i, (s, e, txt) in enumerate(cues, 1):
        lines += [str(i), f"{_ts_srt(s)} --> {_ts_srt(e)}", txt, ""]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _esc(txt: str) -> str:
    return txt.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def _karaoke(s: float, e: float, txt: str) -> str:
    """Word-by-word highlight (ASS \\k), timing spread by word length — the popular Shorts/Reels caption look."""
    words = txt.split()
    if not words:
        return _esc(txt)
    total_cs = max(int(round((e - s) * 100)), len(words))
    weights = [max(len(w), 2) for w in words]
    tw = sum(weights)
    parts = []
    for w_, wt in zip(words, weights):
        parts.append(f"{{\\k{max(int(total_cs * wt / tw), 1)}}}{_esc(w_)}")
    return " ".join(parts)


# Title / lower-third animations: ASS override tags (the browser preview mirrors them with CSS)
TITLE_ANIMS = {
    "none": "",
    "fade": "{{\\fad(250,250)}}",
    "pop": "{{\\fad(100,200)\\fscx70\\fscy70\\t(0,220,\\fscx106\\fscy106)\\t(220,320,\\fscx100\\fscy100)}}",
    "slide_up": "{{\\an{an}\\move({x},{y2},{x},{y},0,350)\\fad(200,200)}}",
    "slide_in": "{{\\an{an}\\move({x2},{y},{x},{y},0,400)\\fad(150,200)}}",
    "zoom": "{{\\fscx135\\fscy135\\t(0,500,\\fscx100\\fscy100)\\fad(150,200)}}",
    "blur_in": "{{\\blur14\\t(0,450,\\blur0)\\fad(150,200)}}",
    "typewriter": "",
}


def write_ass(cues: list[Cue], path: Path, w: int, h: int, font: str, style: str = "shorts",
              caption_style: str = "clean", overlays: list[dict] | None = None,
              colors: tuple[str, str] = ("&H0000D7FF", "&H00FFFFFF")) -> Path:
    """caption_style: clean | karaoke | boxed. overlays: [{text, start, end, kind: title|lower_third}]."""
    vertical = h > w
    size = int(h * (0.042 if vertical else 0.055)) if style == "shorts" else int(h * 0.04)
    margin_v = int(h * (0.22 if vertical else 0.08))
    outline = max(2, size // 12)
    highlight, base = colors
    primary, secondary = (highlight, base) if caption_style == "karaoke" else ("&H00FFFFFF", "&H0000FFFF")
    border_style, back = (3, "&H96000000") if caption_style == "boxed" else (1, "&H64000000")
    title_size = int(size * 1.6)
    lower_size = int(size * 0.8)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},{secondary},&H00000000,{back},-1,0,0,0,100,100,0,0,{border_style},{outline},1,2,{int(w * 0.06)},{int(w * 0.06)},{margin_v},1
Style: Title,{font},{title_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,{outline + 1},2,8,{int(w * 0.06)},{int(w * 0.06)},{int(h * 0.12)},1
Style: Lower,{font},{lower_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,{outline},0,1,{int(w * 0.05)},{int(w * 0.05)},{int(h * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for s, e, txt in cues:
        t = _karaoke(s, e, txt) if caption_style == "karaoke" else _esc(txt)
        events.append(f"Dialogue: 0,{_ts_ass(s)},{_ts_ass(e)},Default,,0,0,0,,{t}")
    for ov in overlays or []:
        title = ov.get("kind", "title") == "title"
        st_name = "Title" if title else "Lower"
        start, end = float(ov["start"]), float(ov["end"])
        # where the style puts it (Title: top centre, Lower: bottom left), for the moving animations
        x, y, an = (w // 2, int(h * 0.12), 8) if title else (int(w * 0.05), h - int(h * 0.12), 1)
        anim = ov.get("anim") or "fade"
        if anim == "typewriter" and len(ov["text"]) > 1:  # letters appear one by one, then it stays
            chars = list(ov["text"])
            step = min(0.06, max((end - start) * 0.5 / len(chars), 0.02))
            for k in range(1, len(chars) + 1):
                t0 = start + (k - 1) * step
                t1 = start + k * step if k < len(chars) else end
                events.append(f"Dialogue: 1,{_ts_ass(t0)},{_ts_ass(t1)},{st_name},,0,0,0,,{{\\an{an}\\pos({x},{y})}}{_esc(''.join(chars[:k]))}")
            continue
        tags = TITLE_ANIMS.get(anim, TITLE_ANIMS["fade"]).format(an=an, x=x, y=y, y2=y + int(h * 0.06), x2=x - int(w * 0.3))
        events.append(f"Dialogue: 1,{_ts_ass(start)},{_ts_ass(end)},{st_name},,0,0,0,,{tags}{_esc(ov['text'])}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return path
