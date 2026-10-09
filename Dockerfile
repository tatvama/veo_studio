# VEO Studio — one image runs the API, the background worker and serves the built web app.
# Build:  docker compose build      Run: docker compose up -d      Open: http://<host>:8100

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# ffmpeg (with libass + harfbuzz for Indic captions), Noto fonts for Devanagari, Kannada, Telugu and Tamil, curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-core fonts-noto-ui-core fontconfig ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt
# Optional: CPU voice/background separation for Voice Lock (adds ~1 GB). Build with --build-arg WITH_DEMUCS=1
ARG WITH_DEMUCS=0
RUN if [ "$WITH_DEMUCS" = "1" ]; then pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu && pip install demucs; fi
COPY backend/ backend/
COPY --from=web /web/dist frontend/dist
ENV CAPTION_FONT="Noto Sans" MEDIA_ROOT=/data/media DATA_ROOT=/data/db
VOLUME ["/data"]
EXPOSE 8100
WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers", "--forwarded-allow-ips=*"]
