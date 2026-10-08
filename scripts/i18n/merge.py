"""Merge translations (scripts/i18n/work/{lang}_NN.json: {"English": "translation"}) into frontend/src/lib/i18n/{lang}.ts.

Workflow after UI text changes:
  python scripts/i18n/keys.py                       # how many strings each language is missing
  python scripts/i18n/keys.py missing kn new.json   # list them; translate into work/kn_NN.json
  python scripts/i18n/merge.py                      # rebuild every dictionary (existing translations are kept)

Checks every entry: placeholders like {n} must match the English key exactly (same set), otherwise the entry is
dropped (the UI then shows English for it) and reported. Keys that no longer exist in the source are dropped.
Existing dictionary entries are kept unless a work file overrides them.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from keys import keys  # noqa: E402

WORK = Path(__file__).parent / "work"
OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "i18n"
PH = re.compile(r"\{(\w+)\}")
NAMES = {"hi": "Hindi", "kn": "Kannada", "te": "Telugu", "ta": "Tamil"}

current = set(keys())
langs = sys.argv[1:] or list(NAMES)
def existing(lang: str) -> dict[str, str]:
    path = OUT / f"{lang}.ts"
    if not path.exists():
        return {}
    m = re.search(r"=\s*(\{.*\})\s*;\s*export default", path.read_text(encoding="utf-8"), re.S)
    try:
        return json.loads(m.group(1)) if m else {}
    except json.JSONDecodeError:
        return {}


for lang in langs:
    merged: dict[str, str] = {}
    bad: list[str] = []
    sources = [existing(lang)] + [json.loads(f.read_text(encoding="utf-8")) for f in sorted(WORK.glob(f"{lang}_*.json"))]
    for data in sources:
        for en, tr in data.items():
            if en not in current or not isinstance(tr, str) or not tr.strip():
                continue
            if sorted(PH.findall(en)) != sorted(PH.findall(tr)):
                bad.append(en)
                continue
            merged[en] = tr
    missing = sorted(current - set(merged))
    body = json.dumps(dict(sorted(merged.items())), ensure_ascii=False, indent=2)
    (OUT / f"{lang}.ts").write_text(
        f"// {NAMES[lang]} UI strings (English → {NAMES[lang]}). Generated from the UI source; keys are the English text.\n"
        f"// Missing keys fall back to English.\n"
        f"const dict: Record<string, string> = {body};\nexport default dict;\n", encoding="utf-8")
    print(f"{lang}: {len(merged)} translated, {len(bad)} dropped (placeholder mismatch), {len(missing)} missing")
    for b in bad[:10]:
        print("   placeholder mismatch:", b[:90])
