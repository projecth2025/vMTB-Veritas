# GPU support: build with --build-arg STT_DEVICE=gpu to pull the CUDA runtime
# via pip (ctranslate2 works with these wheels on Cloud Run GPU instances).
ARG STT_DEVICE=cpu
FROM python:3.11-slim

# Re-declare inside the stage: args from before FROM are NOT inherited here.
ARG STT_DEVICE=cpu
ARG STT_MODEL=medium

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir uv && uv pip install --no-cache-dir --system -r requirements.txt

RUN if [ "$STT_DEVICE" = "gpu" ]; then \
      pip install --no-cache-dir \
        nvidia-cuda-runtime-cu12 \
        nvidia-cudnn-cu12 \
        nvidia-cublas-cu12 \
        nvidia-cuda-nvrtc-cu12 \
        nvidia-cufft-cu12 && \
      for d in /usr/local/lib/python3.11/site-packages/nvidia/*/lib; do \
        echo "$d" >> /etc/ld.so.conf.d/cuda.conf; \
      done && \
      ldconfig; \
    fi

COPY app ./app

# Bake the Whisper model into the image at build time so Cloud Run instances
# start without hitting HuggingFace. Bakes on CPU regardless of runtime device.
RUN STT_MODEL=${STT_MODEL} python -c "from faster_whisper import WhisperModel; WhisperModel('${STT_MODEL}', device='cpu', compute_type='int8'); print('model baked:', '${STT_MODEL}')"

# Build-time assertion: never ship a GPU image without the CUDA libraries.
# (This failed silently for weeks because ARGs declared before FROM are not
# visible inside the stage - see the re-declaration at the top.)
RUN if [ "$STT_DEVICE" = "gpu" ]; then \
      test -f /usr/local/lib/python3.11/site-packages/nvidia/cublas/lib/libcublas.so.12 \
        || { echo "FATAL: libcublas.so.12 missing from GPU image"; exit 1; }; \
      echo "GPU image OK: cublas present"; \
    fi

# Listen on $PORT (Cloud Run injects PORT=8080); fall back to 9090 locally.
EXPOSE 9090
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-9090}"]