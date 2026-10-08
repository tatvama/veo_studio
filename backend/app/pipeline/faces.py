"""Face detection + identity matching (OpenCV YuNet + SFace) and face-aware reframing.

Identity matching needs two small ONNX models from the official OpenCV Zoo
(run `python scripts/get_face_models.py` once). Without them, detection falls back to OpenCV's
built-in Haar cascade (reframing still works) and identity QC falls back to the Gemini vision check.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from ..config import get_settings

YUNET = "face_detection_yunet_2023mar.onnx"
SFACE = "face_recognition_sface_2021dec.onnx"


def models_dir() -> Path:
    return get_settings().data_root / "models" / "face"


def identity_available() -> bool:
    d = models_dir()
    return (d / YUNET).exists() and (d / SFACE).exists()


@lru_cache
def _cv():
    import cv2  # noqa: F401  (optional dependency)
    return cv2


@lru_cache
def _recognizer():
    cv2 = _cv()
    return cv2.FaceRecognizerSF.create(str(models_dir() / SFACE), "")


def _detector(w: int, h: int):
    cv2 = _cv()
    det = cv2.FaceDetectorYN.create(str(models_dir() / YUNET), "", (w, h), 0.7, 0.3, 5000)
    det.setInputSize((w, h))
    return det


def _read(path: Path | str):
    cv2 = _cv()
    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"cannot read image {path}")
    return img


def detect(img) -> list[dict[str, Any]]:
    """→ [{box:(x,y,w,h), score, raw}] largest first. Uses YuNet if available, else Haar."""
    cv2 = _cv()
    h, w = img.shape[:2]
    faces: list[dict[str, Any]] = []
    if identity_available():
        _, res = _detector(w, h).detect(img)
        for row in (res if res is not None else []):
            x, y, bw, bh = [float(v) for v in row[:4]]
            faces.append({"box": (x, y, bw, bh), "score": float(row[-1]), "raw": row})
    else:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        casc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        for (x, y, bw, bh) in casc.detectMultiScale(gray, 1.1, 5, minSize=(max(24, w // 30), max(24, h // 30))):
            faces.append({"box": (float(x), float(y), float(bw), float(bh)), "score": 0.5, "raw": None})
    faces.sort(key=lambda f: -(f["box"][2] * f["box"][3]))
    return faces


def embedding_of(img) -> list[float] | None:
    if not identity_available():
        return None
    faces = detect(img)
    if not faces or faces[0]["raw"] is None:
        return None
    rec = _recognizer()
    aligned = rec.alignCrop(img, faces[0]["raw"])
    feat = rec.feature(aligned)
    return [float(v) for v in feat.flatten()]


def embedding(path: Path | str) -> list[float] | None:
    return embedding_of(_read(path))


def similarity(a: list[float], b: list[float]) -> float:
    import numpy as np
    va, vb = np.asarray(a, dtype="float32"), np.asarray(b, dtype="float32")
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb)) or 1.0
    return float(np.dot(va, vb) / denom)


def best_match_in_frames(frames: list[Path], refs: list[list[float]]) -> dict[str, Any]:
    """Max cosine similarity between any face in the frames and any reference embedding."""
    if not identity_available() or not refs:
        return {"available": False}
    best, faces_seen = -1.0, 0
    rec = _recognizer()
    for f in frames:
        img = _read(f)
        for face in detect(img)[:4]:
            if face["raw"] is None:
                continue
            faces_seen += 1
            feat = [float(v) for v in rec.feature(rec.alignCrop(img, face["raw"])).flatten()]
            for r in refs:
                best = max(best, similarity(feat, r))
    return {"available": True, "similarity": round(best, 3) if faces_seen else None, "faces_seen": faces_seen}


def face_center(video_frames: list[Path]) -> tuple[float, float] | None:
    """Median centre (0–1) of the largest face across sampled frames — used to aim the reframe crop."""
    xs, ys = [], []
    for f in video_frames:
        img = _read(f)
        h, w = img.shape[:2]
        faces = detect(img)
        if faces:
            x, y, bw, bh = faces[0]["box"]
            xs.append((x + bw / 2) / w)
            ys.append((y + bh / 2) / h)
    if not xs:
        return None
    xs.sort()
    ys.sort()
    return xs[len(xs) // 2], ys[len(ys) // 2]
