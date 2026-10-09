"""Pictures and links for MCP clients: keyframes come back as small inline images; videos as signed links that open
in a browser for a few hours without a Tatvam login (the /media route accepts the signature)."""
from __future__ import annotations

import io
from urllib.parse import quote

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from mcp.server.mcpserver import Image

from ..config import get_settings
from ..models import Take
from ..storage import get_storage

LINK_TTL_S = 6 * 3600


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().app_secret, salt="tatvam-media-link")


def signed_link(path: str) -> str:
    """An absolute link to a media file that works without a login for LINK_TTL_S seconds."""
    if not path:
        return ""
    rel = path.replace("\\", "/").lstrip("/")
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/media/{quote(rel)}?sig={_signer().dumps(rel)}"


def check_link(path: str, sig: str | None) -> bool:
    if not sig:
        return False
    try:
        return _signer().loads(sig, max_age=LINK_TTL_S) == path.replace("\\", "/").lstrip("/")
    except (BadSignature, SignatureExpired):
        return False


def thumbnail(take: Take | None, max_side: int = 640) -> Image | None:
    """A JPEG of a keyframe (or a video's thumbnail), small enough to send inline. None when there is no file."""
    if take is None:
        return None
    st = get_storage()
    rel = take.path if take.kind == "keyframe" else (take.thumb_path or "")
    if not rel or not st.exists(rel):
        return None
    try:
        from PIL import Image as PILImage

        with PILImage.open(st.abs(rel)) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80)
        return Image(data=buf.getvalue(), format="jpeg")
    except Exception:  # an unreadable file must not fail the whole storyboard
        return None
