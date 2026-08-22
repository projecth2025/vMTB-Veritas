# GPU support: build with --build-arg STT_DEVICE=gpu to pull the CUDA runtime
# via pip (ctranslate2 works with these wheels on Cloud Run GPU instances).
ARG STT_DEVICE=cpu
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir uv && uv pip install --no-cache-dir --system -r requirements.txt

RUN if [ "$STT_DEVICE" = "gpu" ]; then \
      pip install --no-cache-dir nvidia-cuda-runtime-cu12 nvidia-cudnn-cu12 && \
      echo "/usr/local/lib/python3.11/site-packages/nvidia/cuda_runtime/lib" >> /etc/ld.so.conf.d/cuda.conf && \
      echo "/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib" >> /etc/ld.so.conf.d/cuda.conf && \
      ldconfig; \
    fi

COPY app ./app

# Bake the Whisper model into the image at build time so Cloud Run instances
# start without hitting HuggingFace. Bakes on CPU regardless of runtime device.
ARG STT_MODEL=medium
RUN STT_MODEL=${STT_MODEL} python -c "from faster_whisper import WhisperModel; WhisperModel('${STT_MODEL}', device='cpu', compute_type='int8'); print('model baked:', '${STT_MODEL}')"

# Listen on $PORT (Cloud Run injects PORT=8080); fall back to 9090 locally.
EXPOSE 9090
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-9090}"]