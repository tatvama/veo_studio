"""R2/S3 storage: uploads on save, downloads a missing file on first use, and never touches the network for
files that are already on disk."""
from __future__ import annotations

import time

from app.storage import S3Storage


class NotFound(Exception):
    response = {"Error": {"Code": "404"}}


class FakeBucket:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.gets = 0

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[Key] = Body.read()

    def download_file(self, bucket, key, dest):
        self.gets += 1
        if key not in self.objects:
            raise NotFound()
        with open(dest, "wb") as fh:
            fh.write(self.objects[key])


def wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end and not cond():
        time.sleep(0.02)
    assert cond()


def test_save_uploads_and_other_machine_downloads(tmp_path):
    bucket = FakeBucket()
    a = S3Storage(tmp_path / "machine_a", client=bucket, bucket="b")
    rel = a.save_bytes("projects/1/shots/2/video/clip.mp4", b"video-bytes")
    wait_for(lambda: rel in bucket.objects)
    assert bucket.gets == 0  # saving never downloads

    b = S3Storage(tmp_path / "machine_b", client=bucket, bucket="b")
    assert b.exists(rel)
    assert b.abs(rel).read_bytes() == b"video-bytes"
    b.abs(rel)
    assert bucket.gets == 1  # cached on disk after the first download
    assert not list(b.abs(rel).parent.glob("*.part"))


def test_missing_file_is_not_requested_again_right_away(tmp_path):
    bucket = FakeBucket()
    st = S3Storage(tmp_path, client=bucket, bucket="b")
    assert not st.exists("projects/1/nope.png")
    assert not st.exists("projects/1/nope.png")
    assert bucket.gets == 1
    st._misses["projects/1/nope.png"] -= S3Storage.MISS_TTL_S + 1
    bucket.objects["projects/1/nope.png"] = b"png"
    assert st.exists("projects/1/nope.png")


def test_scratch_and_bad_paths(tmp_path):
    bucket = FakeBucket()
    st = S3Storage(tmp_path, client=bucket, bucket="b")
    assert not st.exists("_tmp/abc/x.wav")
    assert bucket.gets == 0
    try:
        st.abs("../outside.txt")
        raise AssertionError("path escape not refused")
    except ValueError:
        pass
