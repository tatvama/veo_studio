"""Media storage. Files always live on local disk (FFmpeg needs them there);
the "s3" backend additionally mirrors every saved file to an S3-compatible bucket (e.g. Cloudflare R2)."""
from __future__ import annotations

import mimetypes
import os
import shutil
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from .config import get_settings


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        # Pure string normalisation (no filesystem calls): Path.resolve() on Windows can flip between
        # 8.3 short names and long names while folders are being created concurrently.
        self._root_abs = os.path.abspath(self.root)
        self._root_cmp = os.path.normcase(self._root_abs)

    def abs(self, rel: str) -> Path:
        p = os.path.abspath(os.path.join(self._root_abs, rel))
        if os.path.commonpath([self._root_cmp, os.path.normcase(p)]) != self._root_cmp:
            raise ValueError("path escapes media root")
        return Path(p)

    def new_path(self, folder: str, ext: str) -> str:
        ext = ext if ext.startswith(".") else f".{ext}"
        return f"{folder.strip('/')}/{uuid.uuid4().hex[:12]}{ext}"

    def save_bytes(self, rel: str, data: bytes) -> str:
        p = self.abs(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self._after_save(rel)
        return rel

    def save_file(self, rel: str, src: Path, move: bool = False) -> str:
        p = self.abs(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        if move:
            shutil.move(str(src), p)
        else:
            shutil.copyfile(src, p)
        self._after_save(rel)
        return rel

    def exists(self, rel: str) -> bool:
        return bool(rel) and self.abs(rel).exists()

    def url(self, rel: str) -> str:
        return f"/media/{rel}" if rel else ""

    def tmp_dir(self) -> Path:
        d = self.root / "_tmp" / uuid.uuid4().hex[:10]
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _after_save(self, rel: str) -> None:  # overridden by mirror backend
        pass


class S3MirrorStorage(LocalStorage):
    def __init__(self, root: Path):
        super().__init__(root)
        import boto3  # optional dependency, only needed for this backend

        from botocore.config import Config

        s = get_settings()
        self.bucket = s.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url or None,
            aws_access_key_id=s.s3_access_key_id or None,
            aws_secret_access_key=s.s3_secret_access_key or None,
            region_name="auto" if "r2.cloudflarestorage.com" in (s.s3_endpoint_url or "") else None,
            # newer boto sends streaming (aws-chunked) checksums by default, which R2 and other S3-compatible stores
            # reject; the retry then fails with "stream is not seekable". Only checksum when the API requires it.
            config=Config(request_checksum_calculation="when_required", response_checksum_validation="when_required",
                          retries={"max_attempts": 4, "mode": "standard"}),
        )

    def _after_save(self, rel: str) -> None:
        def upload():
            try:
                ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
                with open(self.abs(rel), "rb") as fh:  # a real (seekable) file, so a retry can resend it
                    self.client.put_object(Bucket=self.bucket, Key=rel, Body=fh, ContentType=ctype)
            except Exception as e:  # mirror failures must never break generation
                print(f"[storage] S3 mirror failed for {rel}: {e}")

        threading.Thread(target=upload, daemon=True).start()


@lru_cache
def get_storage() -> LocalStorage:
    s = get_settings()
    if s.storage_backend == "s3" and s.s3_bucket:
        return S3MirrorStorage(s.media_root)
    return LocalStorage(s.media_root)
