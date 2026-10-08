"""Split all UI strings into chunk files for translators: scripts/i18n/work/src_NN.json (English keys + source file)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from keys import keys  # noqa: E402

OUT = Path(__file__).parent / "work"
OUT.mkdir(exist_ok=True)
for old in OUT.glob("src_*.json"):
    old.unlink()
k = keys()
# group by source file so each chunk has related context; then cut into chunks of ~240
ordered = sorted(k, key=lambda s: (k[s], s))
size = 240
chunks = [ordered[i:i + size] for i in range(0, len(ordered), size)]
for i, c in enumerate(chunks):
    (OUT / f"src_{i:02}.json").write_text(json.dumps([{"en": s, "file": k[s]} for s in c], ensure_ascii=False, indent=1),
                                          encoding="utf-8")
print(len(k), "keys in", len(chunks), "chunks ->", OUT)
