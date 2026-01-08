FROM python:3.11-slim

WORKDIR /app/backend

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/src ./src
COPY weights /app/weights
COPY yolo11n.pt /app/yolo11n.pt

ENV PORT=8080

CMD ["gunicorn", "-b", "0.0.0.0:8080", "src.main:app"]
