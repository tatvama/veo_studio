"""R2/S3 storage: uploads on save, downloads a missing file on first use, and never touches the network for
files that are already on disk."""
from __future__ import annotations

import os
import threading
import time

import pytest

from app.storage import LocalStorage, S3Storage, _strip_long_prefix, safe_key


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
    with pytest.raises(ValueError):
        st.abs("../outside.txt")
    assert bucket.gets == 0  # refused before anything is asked of the bucket


@pytest.mark.parametrize("bad", [
    "../x", "a/../../x", "a/../x", "..", "a\\..\\..\\x", "/etc/passwd", "\\\\server\\share\\x", "//server/share/x",
    "C:/Windows/x", "c:x", "a\0b",
])
def test_safe_key_refuses_escapes(bad):
    with pytest.raises(ValueError):
        safe_key(bad)


def test_safe_key_cleans_keys():
    assert safe_key("projects/1/a.mp4") == "projects/1/a.mp4"
    assert safe_key("projects\\1\\a.mp4") == "projects/1/a.mp4"
    assert safe_key("./projects//1/./a.mp4/") == "projects/1/a.mp4"
    assert safe_key("") == "" and safe_key(".") == ""
    assert safe_key("a..b/c...mp4") == "a..b/c...mp4"  # dots inside a name are fine


def test_windows_long_prefix_is_dropped_for_the_link_check():
    assert _strip_long_prefix(r"\\?\D:\media\a.mp4") == r"D:\media\a.mp4"
    assert _strip_long_prefix(r"\\?\UNC\server\share\a.mp4") == r"\\server\share\a.mp4"
    assert _strip_long_prefix(r"D:\media\a.mp4") == r"D:\media\a.mp4"
    assert _strip_long_prefix("/srv/media/a.mp4") == "/srv/media/a.mp4"


def test_local_paths_stay_under_the_root(tmp_path):
    st = LocalStorage(tmp_path / "media")
    root = os.path.abspath(tmp_path / "media")
    assert str(st.abs("projects/1/a.mp4")) == os.path.join(root, "projects", "1", "a.mp4")
    assert str(st.abs("projects\\1\\a.mp4")) == os.path.join(root, "projects", "1", "a.mp4")
    assert str(st.abs("")) == root
    for bad in ("../x", "/x", "C:x"):
        with pytest.raises(ValueError):
            st.abs(bad)
        with pytest.raises(ValueError):
            st.save_bytes(bad, b"x")
    assert not (tmp_path / "x").exists()


def test_saves_into_new_folders_from_many_workers_at_once(tmp_path):
    """Workers saving into folders that other workers are creating at that moment (Windows' realpath can answer with
    a \\\\?\\ path then): every save lands under the root."""
    st = LocalStorage(tmp_path / "media")
    fails: list[str] = []

    def work():
        for i in range(60):
            try:
                st.save_bytes(st.new_path(f"characters/{i // 3}/voices", ".wav"), b"x")
            except Exception as e:  # collected and reported below
                fails.append(repr(e))

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not fails, fails[:3]
    assert len(list((tmp_path / "media" / "characters").rglob("*.wav"))) == 8 * 60


def test_a_link_out_of_the_root_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    st = LocalStorage(tmp_path / "media")
    try:
        os.symlink(outside, tmp_path / "media" / "link", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this system can't make symlinks")
    with pytest.raises(ValueError):
        st.abs("link/secret.txt")  # resolved, it's outside the media root
    with pytest.raises(ValueError):
        st.save_bytes("link/new.txt", b"x")
    assert not (outside / "new.txt").exists()
