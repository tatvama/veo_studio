"""Downloads the two small OpenCV Zoo face models used for identity QC (≈ 37 MB total).

    backend/.venv/Scripts/python scripts/get_face_models.py

Source: https://github.com/opencv/opencv_zoo (official OpenCV project, Apache-2.0 / MIT licensed models).
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.pipeline.faces import SFACE, YUNET, models_dir  # noqa: E402

URLS = {
    YUNET: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    SFACE: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}

if __name__ == "__main__":
    d = models_dir()
    d.mkdir(parents=True, exist_ok=True)
    for name, url in URLS.items():
        target = d / name
        if target.exists() and target.stat().st_size > 100_000:
            print(f"✓ {name} already present")
            continue
        print(f"↓ {name} …")
        with httpx.stream("GET", url, follow_redirects=True, timeout=300) as r:
            r.raise_for_status()
            with open(target, "wb") as fh:
                for chunk in r.iter_bytes():
                    fh.write(chunk)
        print(f"✓ {name} ({target.stat().st_size // 1024} KB)")
    print(f"Face models ready in {d}")
