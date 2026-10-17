"""Free sound effects, no ElevenLabs: recorded spot effects from the bundled Kenney CC0 packs and ambience synthesized
by FFmpeg (no files at all), both picked from the words a script writes ("heavy rain on a tin roof", "footsteps on the
wooden stairs", "a door slams").

The sound-design job uses it when no ElevenLabs key is connected (workers/handlers_growth.py, the free route): each shot
gets one WAV of its own length, the scene's ambience under the shot's spot effects, saved as Shot.sfx_track like an
ElevenLabs one, so the export, the desktop render and the timeline mix it the same way. Ambience is levelled to about
-24 LUFS and spot effects to a -6 dBFS peak so they sit under the voices; the track's own gain (FREE_VOLUME_DB) does the
rest. Everything is seeded by the shot: the same notes make the same sound on every run.
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from ..config import ROOT
from . import ffmpeg as ff

PACKS = ("impact", "interface", "scifi", "ui", "digital")
RATE = 48000
AMBIENCE_LUFS = -24.0  # under the voices: the finished mix is normalised to -14 LUFS
SPOT_PEAK_DB = -6.0
LAYER2_DB = -6.0  # a second ambience (rain under wind) sits below the first
FREE_VOLUME_DB = -6.0  # the free track's gain in the mix (Shot.sfx_track.volume_db)
MAX_SPOTS, MAX_AMBIENCES, MAX_EVENTS = 2, 2, 48


# ── where the recorded packs are ─────────────────────────────────────────────

def library_dirs() -> list[Path]:
    """Where the recorded packs may be: the built frontend first (the Docker image and every served build carry them
    in frontend/dist/sfx/recorded, the folder main.py serves), then the source folder of a checkout not built yet."""
    return [ROOT / "frontend" / "dist" / "sfx" / "recorded", ROOT / "frontend" / "public" / "sfx" / "recorded"]


@lru_cache
def _names(root: str, pack: str) -> tuple[str, ...]:
    d = Path(root) / pack
    return tuple(sorted(p.name for p in d.glob("*.ogg"))) if d.is_dir() else ()


def library_dir() -> Path | None:
    return next((d for d in library_dirs() if any(_names(str(d), p) for p in PACKS)), None)


def recorded(pack: str, prefix: str) -> list[Path]:
    """The pack's files whose names start with `prefix` ("impactwood_heavy" → impactwood_heavy_000.ogg …)."""
    root = library_dir()
    return [root / pack / n for n in _names(str(root), pack) if n.startswith(prefix)] if root else []


# ── words → sounds ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Spot:
    """A spot effect: the words that ask for it (regex alternatives, whole words), the recorded files that fit
    ((pack, name prefix), any of them) and how it plays across the shot."""
    name: str
    words: str
    files: tuple[tuple[str, str], ...] = ()
    pattern: str = "once"  # once | knock (three raps) | steps (a walk through the shot) | loop (all through) | ticks
    generic: bool = False  # only when nothing more specific matched ("drops the plate" is the plate, not a thud)


_DOOR_OBJ = r"(?:the |a |his |her |their |its )?doors?"
_BREAKABLE = r"(?:glass|window|bottle|mirror|vase|pane)\w*"
SPOTS: tuple[Spot, ...] = (  # checked in this order; what one matches is taken out of the text for the next
    Spot("knock", r"(?:door\s+)?knock\w*(?:\s+(?:at|on)\s+" + _DOOR_OBJ + r")?",
         (("impact", "impactwood_heavy"), ("impact", "impactwood_medium")), "knock"),
    Spot("door closes", r"doors?\W+(?:\w+\W+){0,3}?(?:clos\w*|slam\w*|shut\w*|bang\w*)|(?:clos\w*|slam\w*|shut\w*) " + _DOOR_OBJ,
         (("scifi", "doorclose"),)),
    Spot("door opens", r"doors?\W+(?:\w+\W+){0,3}?(?:open\w*|creak\w*|swing\w*)|(?:open\w*|push\w*) " + _DOOR_OBJ + "|doors?",
         (("scifi", "dooropen"),)),
    Spot("footsteps", r"foot ?steps?|footfalls?|walk(?:s|ing|ed)?|steps|strides?|pac(?:es|ing)|tiptoe\w*", (), "steps"),
    Spot("glass breaks", rf"(?:{_BREAKABLE}\W+(?:\w+\W+){{0,2}}?)?(?:shatter\w*|smash\w*)|{_BREAKABLE}\W+(?:\w+\W+){{0,2}}?break\w*"
         rf"|(?:shatter|smash|break)\w*\W+(?:\w+\W+){{0,2}}?{_BREAKABLE}", (("impact", "impactglass_heavy"),)),
    Spot("glass", r"glass\w*|clink\w*|bottles?", (("impact", "impactglass_light"), ("impact", "impactglass_medium"))),
    Spot("match strikes", r"match\w*\W+(?:strik\w*|struck|lit|flar\w*|scrap\w*)|(?:strik\w*|light\w*|lit) (?:a |the )?match\w*"
         r"|matchsticks?", (("interface", "scratch"),)),
    Spot("metal", r"metal\w*|clang\w*|clank\w*|steel|iron|swords?",
         (("impact", "impactmetal_heavy"), ("impact", "impactmetal_medium"), ("scifi", "impactmetal"))),
    Spot("punch", r"punch\w*|hits?|hitting|slap\w*|kicks?|kicked|kicking|fight\w*|struck",
         (("impact", "impactpunch_heavy"), ("impact", "impactpunch_medium"))),
    Spot("bell", r"bells?|chimes?|gongs?|ghanta", (("impact", "impactbell_heavy"),)),
    Spot("plates", r"plates?|dish(?:es)?|cups?|saucers?|utensils?|cutlery|tumblers?|vessels?|spoons?",
         (("impact", "impactplate_light"), ("impact", "impactplate_medium"))),
    Spot("explosion", r"explo\w*|blasts?|bomb\w*|boom\w*|blows? up",
         (("scifi", "explosioncrunch"), ("scifi", "lowfrequency_explosion"))),
    Spot("thud", r"thud\w*|thump\w*|falls?|falling|fell|drops?|dropped|dropping|collaps\w*|slumps?|crash\w*",
         (("impact", "impactsoft_heavy"),), generic=True),
    Spot("engine", r"engines?|motor\w*|cars?|trucks?|(?:motor)?bikes?|scooters?|rickshaws?|bus|buses|vehicles?|tractors?|jeeps?",
         (("scifi", "spaceenginelow"),), "loop"),
    Spot("laser", r"lasers?|zap\w*|blasters?|ray guns?",
         (("scifi", "laserlarge"), ("scifi", "lasersmall"), ("scifi", "laserretro"), ("digital", "laser"))),
    Spot("click", r"click\w*|switch\w*|buttons?|toggles?|keyboard|typing",
         (("interface", "click"), ("interface", "switch"), ("ui", "click"))),
    Spot("ticking", r"tick\w*|clocks?", (("interface", "tick"),), "ticks"),
)
SURFACES = (  # where footsteps land (Kenney's footstep_<surface>_NNN files); concrete when the words don't say
    ("wood", r"wood\w*|floorboards?|planks?|decks?|stairs?|staircase|porch|bridge"),
    ("snow", r"snow\w*|ice|icy"),
    ("grass", r"grass\w*|lawn|fields?|meadow|garden|leaves|forest|jungle|mud\w*|earth|dirt|gravel|sand\w*"),
    ("carpet", r"carpet\w*|rugs?|mats?"),
    ("concrete", r"concrete|stone\w*|floors?|pavement|tiles?|tiled|marble|streets?|road|corridor|hall\w*|courtyard"),
)
# words that look like a spot effect but aren't one ("rain falls", "nightfall"): taken out before the spots are matched
NOT_SPOTS = r"(?:rain|snow|water|leaves|night|silence|darkness|dusk|dew|light)\w*\s+(?:falls?|falling|fell)|\w+falls?"
AMBIENCE_WORDS: tuple[tuple[str, str], ...] = (  # in priority order; the first two that match are layered
    ("storm", r"heavy rain|downpour|storms?|stormy|thunder\w*|monsoon|torrential|cloudburst|lightning"),
    ("rain", r"rain(?:s|y|ing|fall|drops?)?|drizzl\w*|showers?"),
    ("sea", r"seas?|ocean\w*|waves?|surf|shore|beach|tides?|seaside"),
    ("water", r"rivers?|streams?|brook|creek|water\w*|fountains?|canal|drip\w*"),
    ("wind", r"winds?|windy|breez\w*|gusts?|gusty|howling|blizzard"),
    ("fire", r"fires?|fireplace|fireside|crackl\w*|bonfire|campfire|flames?|hearth|burning|embers?"),
    ("crowd", r"crowds?|crowded|market\w*|bazaar|murmur\w*|chatter\w*|festival|caf[eé]s?|restaurant|audience|party"
              r"|classroom|gathering|people talking"),
    ("city", r"city|traffic|streets?|cars?|horns?|honk\w*|roads?|highway|town|rickshaws?|bus|buses"),
    ("birds", r"birds?|birdsong|chirp\w*|dawn chorus|morning|sparrows?|cuckoo|koel|forest|jungle"),
    ("night", r"night\w*|crickets?|insects?|cicadas?|frogs?"),
    ("room", r"room tone|rooms?|quiet|silen\w*|hush\w*|indoors?|interior|office|hall|library|still air|hum(?:s|ming)?"),
)
EXCLUDES = {"storm": {"rain"}, "sea": {"water"}}  # the first already carries the second


def _rx(words: str) -> re.Pattern:
    return re.compile(rf"\b(?:{words})\b", re.I)


_SPOT_RX = [(s, _rx(s.words)) for s in SPOTS]
_SURFACE_RX = [(n, _rx(w)) for n, w in SURFACES]
_AMB_RX = [(n, _rx(w)) for n, w in AMBIENCE_WORDS]
_NOT_SPOTS_RX = _rx(NOT_SPOTS)


def ambiences_for(text: str) -> list[str]:
    """The ambiences the words ask for, most specific first (a storm before rain), at most MAX_AMBIENCES."""
    out: list[str] = []
    for name, rx in _AMB_RX:
        if rx.search(text or "") and not any(name in EXCLUDES.get(o, ()) for o in out):
            out.append(name)
    return out[:MAX_AMBIENCES]


def spots_for(text: str) -> list[tuple[Spot, str]]:
    """(spot, footstep surface or "") the words ask for, in the order they are written, at most MAX_SPOTS."""
    rest = _NOT_SPOTS_RX.sub(" ", (text or "").lower())
    surface = next((n for n, rx in _SURFACE_RX if rx.search(rest)), "concrete")
    found: list[tuple[int, Spot]] = []
    for spot, rx in _SPOT_RX:
        m = rx.search(rest)
        if m and not (spot.generic and found):
            found.append((m.start(), spot))
            rest = rx.sub(lambda x: " " * len(x.group(0)), rest)  # same length: the positions stay comparable
    return [(s, surface if s.pattern == "steps" else "") for _, s in sorted(found, key=lambda f: f[0])][:MAX_SPOTS]


@dataclass
class SoundPlan:
    ambience: list[str] = field(default_factory=list)
    spots: list[tuple[Spot, str]] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.ambience or self.spots)

    @property
    def label(self) -> str:
        """What was made, for Shot.sfx_track.prompt ("ambience: rain, wind · effects: footsteps on wood")."""
        spots = [f"{s.name} on {surf}" if surf else s.name for s, surf in self.spots]
        return " · ".join(p for p in (f"ambience: {', '.join(self.ambience)}" if self.ambience else "",
                                      f"effects: {', '.join(spots)}" if spots else "") if p)


def plan_sound(scene_sound: str, shot_sfx: str) -> SoundPlan:
    """The scene's ambience (from its sound notes, else from the shot's own effect words: "rain on the window") under
    the shot's spot effects. Spot effects whose recorded files aren't here are left out."""
    amb = ambiences_for(scene_sound) or ambiences_for(shot_sfx)
    spots = [(s, surf) for s, surf in spots_for(shot_sfx) if _spot_files(s, surf)]
    return SoundPlan(amb, spots)


def _spot_files(spot: Spot, surface: str) -> list[Path]:
    if spot.pattern == "steps":
        return recorded("impact", f"footstep_{surface or 'concrete'}") or recorded("impact", "footstep_concrete")
    return [p for pack, prefix in spot.files for p in recorded(pack, prefix)]


# ── ambience, synthesized ────────────────────────────────────────────────────

class _Graph:
    """One FFmpeg filter graph of stereo sound sources, each `d` seconds long, seeded from the shot."""

    def __init__(self, d: float, seed: int):
        self.d, self.seed, self.n, self.parts = d, seed, 0, []
        self.ph = round((seed % 628) / 100, 2)  # where the slow swells start: shots don't all breathe together

    def _label(self) -> str:
        self.n += 1
        return f"s{self.n}"

    def noise(self, color: str, amp: float, chain: str, n: int = 1024) -> str:
        """Stereo noise: two independent `color` noises as left and right (a wide, natural bed), through `chain`."""
        o, s = self._label(), (self.seed * 31 + self.n * 7919) % 2**31
        src = f"anoisesrc=c={color}:r={RATE}:a={amp}:n={n}:d={self.d:.3f}"
        self.parts.append(f"{src}:s={s}[{o}l];{src}:s={s + 1}[{o}r];[{o}l][{o}r]amerge=inputs=2,{chain}[{o}]")
        return o

    def expr(self, left: str, right: str, chain: str) -> str:
        """Stereo sound from two aevalsrc expressions (each channel keeps its own random state)."""
        o = self._label()
        self.parts.append(f"aevalsrc='{left}|{right}':s={RATE}:d={self.d:.3f},{chain}[{o}]")
        return o

    def crackle(self, density: float, chain: str, amp: float = 1.0) -> str:
        """Sparse random clicks (rain patter, fire crackle, bubbles): a click on about (1 - density) of the samples."""
        def ch(k: int) -> str:
            a, b = (self.seed * 7 + k * 101 + self.n) % 99991 + 1, (self.seed * 13 + k * 211 + self.n) % 99989 + 1
            return f"if(eq(n,0),st(0,{a})+st(1,{b}),0)*0+{amp}*gt(random(0),{density})*(2*random(1)-1)"
        return self.expr(ch(1), ch(2), chain)

    def swell(self, base: float, depth: float, period: float, power: int = 1, shift: float = 0.0) -> str:
        """A slow volume swell between `base` and `base + depth` every `period` seconds (waves, gusts, passing cars)."""
        wave = f"(0.5+0.5*sin(2*PI*t/{period}+{self.ph + shift}))"
        return f"volume='{base}+{depth}*pow({wave},{power})':eval=frame"


def _rain(g: _Graph) -> list[str]:
    return [g.noise("pink", 0.5, f"highpass=f=450,lowpass=f=9000,{g.swell(0.8, 0.2, 9.1)}"),
            g.crackle(0.9975, "highpass=f=2500,lowpass=f=8000,volume=0.35")]


def _storm(g: _Graph) -> list[str]:
    return [g.noise("pink", 0.6, f"highpass=f=250,lowpass=f=7000,{g.swell(0.85, 0.15, 7.7)}"),
            g.noise("brown", 0.5, "lowpass=f=500,volume=0.8"),
            g.noise("brown", 0.9, f"lowpass=f=110,{g.swell(0.1, 1.6, 13.0, 8)}"),  # thunder rolling in now and then
            g.crackle(0.995, "highpass=f=2000,lowpass=f=7000,volume=0.3")]


def _wind(g: _Graph) -> list[str]:
    gust = f"volume='0.25+0.75*(0.5+0.5*sin(2*PI*t/7.3+{g.ph})*sin(2*PI*t/3.1+1.3))':eval=frame"
    return [g.noise("pink", 0.5, f"bandpass=f=700:width_type=o:w=1.6,{gust}"),
            g.noise("brown", 0.6, f"lowpass=f=350,{g.swell(0.6, 0.4, 11.0)}")]


def _sea(g: _Graph) -> list[str]:
    return [g.noise("brown", 0.6, f"lowpass=f=1000,{g.swell(0.35, 0.65, 8.5, 2)}"),
            g.noise("pink", 0.4, f"highpass=f=1200,lowpass=f=7000,{g.swell(0.05, 0.95, 8.5, 4, -0.9)}")]  # foam after each crest


def _water(g: _Graph) -> list[str]:
    return [g.noise("pink", 0.5, f"highpass=f=600,lowpass=f=5500,{g.swell(0.85, 0.15, 1.4)}"),
            g.noise("brown", 0.4, "lowpass=f=300"),
            g.crackle(0.996, "bandpass=f=1400:width_type=o:w=1.2,volume=0.5")]  # bubbles


def _room(g: _Graph) -> list[str]:
    return [g.noise("brown", 0.5, "lowpass=f=180"), g.noise("pink", 0.15, "highpass=f=120,lowpass=f=3000")]


def _night(g: _Graph) -> list[str]:
    def crickets(k: int) -> str:  # three crickets: a fast pulse inside a short chirp, each at its own pitch and pace
        o = (g.seed * (k + 3)) % 97 / 100
        return "+".join(f"{a}*sin(2*PI*{f}*t)*lt(mod(t*{r},1),0.5)*lt(mod(t+{o + off},{p}),{c})" for a, f, r, p, c, off in (
            (0.30, 4700 + 60 * k, 29, 0.83, 0.24, 0.13), (0.20, 4300 - 50 * k, 33, 1.07, 0.20, 0.41),
            (0.12, 5200, 25, 0.71 + 0.05 * k, 0.30, 0.70)))
    return [g.noise("brown", 0.3, "lowpass=f=400"), g.expr(crickets(1), crickets(2), "highpass=f=3000,lowpass=f=8000,volume=0.5")]


def _city(g: _Graph) -> list[str]:
    return [g.noise("brown", 0.6, f"lowpass=f=600,{g.swell(0.55, 0.45, 6.7, 2)}"),  # traffic, cars passing
            g.noise("pink", 0.35, f"bandpass=f=1200:width_type=o:w=2,{g.swell(0.6, 0.4, 4.3)}")]


def _fire(g: _Graph) -> list[str]:
    return [g.noise("brown", 0.5, f"lowpass=f=500,{g.swell(0.8, 0.2, 1.1)}"),
            g.crackle(0.9992, "highpass=f=1200,lowpass=f=7000"),
            g.crackle(0.99985, "bandpass=f=1800:width_type=o:w=2,volume=1.5")]  # the bigger pops


def _crowd(g: _Graph) -> list[str]:
    voices = [g.noise("pink", 0.5, f"bandpass=f={f}:width_type=o:w=1,"  # babble: talk-band noise at a talking pace
                                   f"volume='0.25+0.75*pow(0.5+0.5*sin(2*PI*{r}*t+{g.ph + i}),2)':eval=frame", n=256)
              for i, (f, r) in enumerate(((450, 3.1), (900, 4.3), (1600, 2.6)))]
    return [*voices, g.noise("brown", 0.3, "lowpass=f=250")]


def _birds(g: _Graph) -> list[str]:
    def birds(k: int) -> str:  # a few birds: short falling and warbling chirps at their own pace
        o = (g.seed * (k + 5)) % 89 / 100
        fall = "{a}*sin(2*PI*({f}*mod(t+{o},{p})-{s}*pow(mod(t+{o},{p}),2)))*lt(mod(t+{o},{p}),{c})"
        warble = "{a}*sin(2*PI*({f}*t+30*sin(2*PI*14*t)))*lt(mod(t+{o},{p}),{c})"
        return "+".join([fall.format(a=0.25, f=4200 + 150 * k, o=o, p=1.9 + 0.3 * k, s=6000, c=0.14),
                         warble.format(a=0.18, f=3100 - 120 * k, o=o + 0.6, p=2.7 - 0.2 * k, c=0.22)])
    return [g.noise("pink", 0.2, "highpass=f=200,lowpass=f=2500"), g.expr(birds(1), birds(2), "highpass=f=1500,volume=0.5")]


AMBIENCES = {"rain": _rain, "storm": _storm, "wind": _wind, "sea": _sea, "water": _water, "room": _room,
             "night": _night, "city": _city, "fire": _fire, "crowd": _crowd, "birds": _birds}


def synth_ambience(names: list[str], seconds: float, seed: int, out: Path) -> Path:
    """The ambiences layered (the second LAYER2_DB under the first), `seconds` long, levelled to about AMBIENCE_LUFS,
    with 50 ms fades so a cut never clicks. 48 kHz stereo WAV."""
    d = max(float(seconds), 0.5)
    g = _Graph(d, seed)
    layers = []
    for i, name in enumerate(names):
        parts = AMBIENCES[name](g)
        lab = f"amb{i}"
        g.parts.append("".join(f"[{p}]" for p in parts) + f"amix=inputs={len(parts)}:normalize=0:duration=longest"
                       + (f",volume={LAYER2_DB}dB" if i else "") + f"[{lab}]")
        layers.append(lab)
    fade = f"afade=t=in:d=0.05,afade=t=out:st={max(d - 0.05, 0):.3f}:d=0.05"
    g.parts.append("".join(f"[{x}]" for x in layers) + f"amix=inputs={len(layers)}:normalize=0:duration=longest,"
                   f"atrim=0:{d:.3f},{fade}[out]")
    raw = out.with_name(f"{out.stem}.raw.wav")
    ff.run(["-filter_complex", ";".join(g.parts), "-map", "[out]", "-ar", RATE, "-ac", 2, "-c:a", "pcm_s16le", raw])
    level, peak = ff.measure(raw)
    gain = min(AMBIENCE_LUFS - level, 30.0) if level is not None else 0.0
    if peak is not None:
        gain = min(gain, -1.0 - peak)  # never clip: crackles and thunder have big peaks
    ff.run(["-i", raw, "-af", f"volume={gain:.2f}dB", "-c:a", "pcm_s16le", out])
    raw.unlink(missing_ok=True)
    return out


# ── spot effects, recorded ───────────────────────────────────────────────────

def _events(spot: Spot, files: list[Path], seconds: float, rng: random.Random) -> list[tuple[Path, float, bool]]:
    """(file, start s, looped) for each time the spot sounds in a shot of `seconds`."""
    pick = rng.sample(files, min(len(files), 4))  # seeded: the same shot picks the same files every run
    once = min(max(seconds * 0.3 + rng.uniform(-0.15, 0.15), 0.15), max(seconds - 0.8, 0.15))
    if spot.pattern == "loop":
        return [(pick[0], 0.0, True)]
    if spot.pattern == "knock":
        return [(pick[i % len(pick)], once + i * 0.24, False) for i in range(3)]
    if spot.pattern in ("steps", "ticks"):
        out, t, i = [], 0.25 if spot.pattern == "steps" else 0.3, 0
        while t < seconds - 0.25 and len(out) < MAX_EVENTS:
            out.append((pick[i % len(pick)], t, False))
            t += (0.5 + rng.uniform(-0.03, 0.03)) if spot.pattern == "steps" else 1.0
            i += 1
        return out
    return [(pick[0], once, False)]


def compose_spots(spots: list[tuple[Spot, str]], seconds: float, seed: int, out: Path) -> Path | None:
    """The shot's spot effects on one track of `seconds`, peaking at SPOT_PEAK_DB; None when no file fits."""
    rng = random.Random(seed)
    events: list[tuple[Path, float, bool]] = []
    for spot, surface in spots:
        files = _spot_files(spot, surface)
        if files:
            events += _events(spot, files, seconds, rng)
    events = events[:MAX_EVENTS]
    if not events:
        return None
    files = list(dict.fromkeys(e[0] for e in events))  # one input per file, split to each time it sounds
    args: list = []
    parts, labels = [], []
    for fi, f in enumerate(files):
        mine = [e for e in events if e[0] == f]
        args += (["-stream_loop", "-1"] if mine[0][2] else []) + ["-i", f]
        split = f",asplit={len(mine)}" + "".join(f"[f{fi}e{k}]" for k in range(len(mine))) if len(mine) > 1 else f"[f{fi}e0]"
        parts.append(f"[{fi}:a]aresample={RATE},aformat=channel_layouts=stereo{split}")
        for k, (_, at, looped) in enumerate(mine):
            lab = f"f{fi}e{k}o"
            if looped:  # an engine running through the shot, faded in and out
                parts.append(f"[f{fi}e{k}]atrim=0:{seconds:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,"
                             f"afade=t=out:st={max(seconds - 0.6, 0):.3f}:d=0.6[{lab}]")
            else:
                ms = int(at * 1000)
                parts.append(f"[f{fi}e{k}]adelay={ms}|{ms}[{lab}]")
            labels.append(lab)
    # padded to the shot's length by apad's whole_dur and cut by -t: an endless apad before atrim stalls FFmpeg 7 when
    # an input is split (asplit)
    parts.append("".join(f"[{x}]" for x in labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest,"
                 f"apad=whole_dur={seconds:.3f}[out]")
    raw = out.with_name(f"{out.stem}.raw.wav")
    ff.run([*args, "-filter_complex", ";".join(parts), "-map", "[out]", "-t", f"{seconds:.3f}", "-ar", RATE, "-ac", 2,
            "-c:a", "pcm_s16le", raw])
    peak = ff.measure(raw)[1]
    ff.run(["-i", raw, "-af", f"volume={SPOT_PEAK_DB - peak if peak is not None else 0:.2f}dB", "-c:a", "pcm_s16le", out])
    raw.unlink(missing_ok=True)
    return out


def make_shot_sound(scene_sound: str, shot_sfx: str, seconds: float, seed: int, out: Path) -> Path | None:
    """One WAV of the shot's length: the scene's ambience (synthesized) under the shot's spot effects (recorded), or
    None when the words match nothing this library has."""
    plan = plan_sound(scene_sound, shot_sfx)
    if not plan:
        return None
    secs = max(float(seconds), 0.5)
    out.parent.mkdir(parents=True, exist_ok=True)
    amb = synth_ambience(plan.ambience, secs, seed, out.with_name(f"{out.stem}.amb.wav")) if plan.ambience else None
    spot = compose_spots(plan.spots, secs, seed, out.with_name(f"{out.stem}.spot.wav")) if plan.spots else None
    tracks = [t for t in (amb, spot) if t]
    if not tracks:
        return None
    args: list = []
    for t in tracks:
        args += ["-i", t]
    fc = "".join(f"[{i}:a]" for i in range(len(tracks))) + f"amix=inputs={len(tracks)}:normalize=0:duration=longest,apad=whole_dur={secs:.3f}[out]"
    ff.run([*args, "-filter_complex", fc, "-map", "[out]", "-t", f"{secs:.3f}", "-ar", RATE, "-ac", 2, "-c:a", "pcm_s16le", out])
    for t in tracks:
        t.unlink(missing_ok=True)
    return out
