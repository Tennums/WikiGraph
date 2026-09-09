FROM python:3.13-slim
WORKDIR /app
# numpy is the only dependency; the dump parsing is stdlib re + gzip.
RUN pip install --no-cache-dir numpy==2.3.4
COPY ingest/ ./ingest/
ENTRYPOINT ["python", "ingest/build.py", "--dumps", "/data/dumps", "--out", "/data/graph"]
