"""Media storage.

"local" keeps every file on this machine's disk.
"s3" makes an S3-compatible bucket (Cloudflare R2) the shared home of all media, with the local disk as a cache:
every saved file is uploaded to the bucket, and a file that is missing on disk (made on another machine, or the
cache was cleared) is downloaded from the bucket the first time it is needed. FFmpeg and the AI providers still
read real local files, so nothing else in the app has to know where media lives.
"""
from __future__ import annotations

import mimetypes
import os
import shutil
import threading
import time
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

    def _local(self, rel: str) -> Path:
        """Where `rel` lives on this machine's disk (no download)."""
        p = os.path.abspath(os.path.join(self._root_abs, rel))
        if os.path.commonpath([self._root_cmp, os.path.normcase(p)]) != self._root_cmp:
            raise ValueError("path escapes media root")
        return Path(p)

    def abs(self, rel: str) -> Path:
        """A local path to read `rel` from (remote backends make sure the file is on disk first)."""
        return self._local(rel)

    def new_path(self, folder: str, ext: str) -> str:
        ext = ext if ext.startswith(".") else f".{ext}"
        return f"{folder.strip('/')}/{uuid.uuid4().hex[:12]}{ext}"

    def save_bytes(self, rel: str, data: bytes) -> str:
        p = self._local(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self._after_save(rel)
        return rel

    def save_file(self, rel: str, src: Path, move: bool = False) -> str:
        p = self._local(rel)
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

    def _after_save(self, rel: str) -> None:  # overridden by the bucket backend
        pass

    def public_url(self, path: Path, expires_s: int = 6 * 3600) -> str | None:
        """A temporary HTTPS link to a local file that an outside service (OpenRouter, BytePlus) can download.
        None here: files on this disk have no public address. The bucket backend makes one."""
        return None


class S3Storage(LocalStorage):
    """Cloudflare R2 / S3 as the shared store, local disk as a read-through cache."""

    MISS_TTL_S = 15.0  # remember "not in the bucket" briefly, so a missing file isn't re-requested on every call

    def __init__(self, root: Path, client=None, bucket: str | None = None):
        super().__init__(root)
        s = get_settings()
        self.bucket = bucket or s.s3_bucket
        self.client = client or self._make_client(s)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._misses: dict[str, float] = {}
        self._shared: set[str] = set()  # share/ keys known to be in the bucket

    @staticmethod
    def _make_client(s):
        import boto3  # optional dependency, only needed for this backend
        from botocore.config import Config

        return boto3.client(
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

    @staticmethod
    def _key(rel: str) -> str:
        return rel.replace("\\", "/").lstrip("/")

    def abs(self, rel: str) -> Path:
        p = self._local(rel)
        if rel and not p.exists():
            self._fetch(self._key(rel), p)
        return p

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def _fetch(self, key: str, dest: Path) -> None:
        if key.startswith("_tmp/"):
            return  # scratch space is never uploaded
        missed = self._misses.get(key)
        if missed and time.monotonic() - missed < self.MISS_TTL_S:
            return
        with self._lock_for(key):  # one download per file, even when several workers ask at once
            if dest.exists():
                return
            part = dest.with_name(f"{dest.name}.{uuid.uuid4().hex[:8]}.part")
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                self.client.download_file(self.bucket, key, str(part))
                os.replace(part, dest)  # readers never see a half-written file
                self._misses.pop(key, None)
            except Exception as e:
                part.unlink(missing_ok=True)
                if not _is_not_found(e):
                    print(f"[storage] download from bucket failed for {key}: {e}")
                self._misses[key] = time.monotonic()

    def _after_save(self, rel: str) -> None:
        key = self._key(rel)
        self._misses.pop(key, None)

        def upload():
            try:
                ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
                with open(self._local(rel), "rb") as fh:  # a real (seekable) file, so a retry can resend it
                    self.client.put_object(Bucket=self.bucket, Key=key, Body=fh, ContentType=ctype)
            except Exception as e:  # upload failures must never break generation; the file stays on this disk
                print(f"[storage] upload to bucket failed for {rel}: {e}")

        threading.Thread(target=upload, daemon=True).start()

    def public_url(self, path: Path, expires_s: int = 6 * 3600) -> str | None:
        """Copy the file to share/<sha1> in the bucket (once; same content, same key) and return a presigned link.
        A copy rather than the file's own key: saves upload in the background, so the original may not be there yet."""
        import hashlib

        data = Path(path).read_bytes()
        key = f"share/{hashlib.sha1(data).hexdigest()}{Path(path).suffix.lower() or '.bin'}"
        if key not in self._shared:
            try:
                self.client.head_object(Bucket=self.bucket, Key=key)
            except Exception:
                ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
                self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=ctype)
            self._shared.add(key)
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key},
                                                  ExpiresIn=int(expires_s))


S3MirrorStorage = S3Storage  # old name


def _is_not_found(e: Exception) -> bool:
    code = str(((getattr(e, "response", None) or {}).get("Error") or {}).get("Code", ""))
    return code in ("404", "NoSuchKey", "NotFound")


@lru_cache
def get_storage() -> LocalStorage:
    s = get_settings()
    if s.storage_backend == "s3" and s.s3_bucket:
        return S3Storage(s.media_root)
    return LocalStorage(s.media_root)
