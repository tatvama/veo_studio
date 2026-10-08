"""Collect UI strings from frontend/src and report/emit what each language dictionary is missing.

usage: python scripts/i18n/keys.py                    -> counts
       python scripts/i18n/keys.py dump OUT           -> all keys as a JSON list
       python scripts/i18n/keys.py missing LANG OUT   -> JSON list of keys missing in that dictionary

Keys come from t("…") / tr("…") calls plus the English values of label tables that are translated
dynamically (t(MAP[x]), t(o.label) …): object properties named label/desc/title/sub/hint/description and
string values of constant maps/arrays whose name is passed to t().
"""
import json
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"

STR = r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'|`((?:[^`\\$]|\\.)*)`'
CALL = re.compile(r"(?<![\w.])(?:t|tr)\(\s*(?:" + STR + r")")
PROP = re.compile(r"\b(?:label|desc|title|sub|hint|description|empty|help)\s*:\s*(?:" + STR + r")")
DYN = re.compile(r"(?<![\w.])(?:t|tr)\(\s*([A-Z][A-Z0-9_]+)\b")  # t(CONST_MAP[...]) / t(CONST)
MAP_DECL = r"(?:const|let)\s+{name}\b[^=]*=\s*\{{(.*?)\n\}};"
MAP_VAL = re.compile(r":\s*(?:" + STR + r")")
ARR_DECL = r"(?:const|let)\s+{name}\b[^=]*=\s*\[(.*?)\];"


def _unescape(s: str) -> str:
    return s.replace('\\"', '"').replace("\\'", "'").replace("\\n", "\n").replace("\\\\", "\\")


def _first(m: re.Match) -> str | None:
    return next((g for g in m.groups() if g is not None), None)


def looks_like_text(s: str) -> bool:
    s = s.strip()
    if len(s) < 2 or not re.search(r"[A-Za-z]", s):
        return False
    if re.fullmatch(r"[a-z0-9_.:/#\-]+", s):  # ids, routes, css-ish tokens
        return False
    if re.fullmatch(r"(?:[a-z0-9:/\[\]_.%-]+\s+){2,}[a-z0-9:/\[\]_.%-]+", s) and "-" in s:  # tailwind classes
        return False
    return True


def keys() -> dict[str, str]:
    out: dict[str, str] = {}
    for f in sorted(SRC.rglob("*.ts*")):
        if "i18n" in f.parts:
            continue
        txt = f.read_text(encoding="utf-8")
        rel = str(f.relative_to(SRC))
        for m in CALL.finditer(txt):
            k = _first(m)
            if k and k.strip():
                out.setdefault(_unescape(k), rel)
        for m in PROP.finditer(txt):
            k = _first(m)
            if k and looks_like_text(k):
                out.setdefault(_unescape(k), rel)
        for name in set(DYN.findall(txt)):
            for decl in (MAP_DECL, ARR_DECL):
                dm = re.search(decl.format(name=re.escape(name)), txt, re.S)
                if not dm:
                    continue
                body = dm.group(1)
                vals = [_first(v) for v in MAP_VAL.finditer(body)] if decl is MAP_DECL else \
                    [_first(v) for v in re.finditer(STR, body)]
                for v in vals:
                    if v and looks_like_text(v):
                        out.setdefault(_unescape(v), rel)
    return out


def dict_keys(lang: str) -> set[str]:
    txt = (SRC / "lib" / "i18n" / f"{lang}.ts").read_text(encoding="utf-8")
    m = re.search(r"=\s*(\{.*\})\s*;?\s*export default", txt, re.S)
    if not m:
        return set()
    try:
        return set(json.loads(m.group(1)).keys())
    except json.JSONDecodeError:
        return {_unescape(k) for k in re.findall(r'^\s*"((?:[^"\\]|\\.)*)"\s*:', txt, re.M)}


if __name__ == "__main__":
    k = keys()
    if len(sys.argv) == 1:
        print(len(k), "keys,", sum(len(x) for x in k), "chars")
        for lang in ("hi", "kn", "te", "ta"):
            print(lang, "missing", len(set(k) - dict_keys(lang)))
    elif sys.argv[1] == "dump":
        Path(sys.argv[2]).write_text(json.dumps(sorted(k), ensure_ascii=False, indent=0), encoding="utf-8")
        print(len(k))
    elif sys.argv[1] == "missing":
        miss = sorted(set(k) - dict_keys(sys.argv[2]))
        Path(sys.argv[3]).write_text(json.dumps(miss, ensure_ascii=False, indent=0), encoding="utf-8")
        print(len(miss))
