# Our own plate reader (docs/plate-recognition-plan.md). Processor only, no outside connections at run time.
# The model files are not in the repo (one of them was trained on our gate pictures): docker-compose mounts them
# read-only at /models from READER_MODELS_DIR on the host.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /reader
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline.py server.py ./

RUN useradd -u 1000 -m reader
USER reader
ENV PYTHONUNBUFFERED=1 READER_MODELS=/models OMP_NUM_THREADS=1

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8091/health', timeout=4)" || exit 1

CMD ["python", "server.py"]
