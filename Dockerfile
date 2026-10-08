# Imagen única: compila el frontend y lo sirve desde FastAPI (mismo origen que la API, webhooks y el WS de voz).
FROM node:22-alpine AS front
WORKDIR /front
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ENTORNO=produccion DIRECTORIO_DATOS=/datos
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY widget /app/widget
COPY --from=front /front/dist /app/frontend/dist
RUN useradd -r -u 1001 platzito && mkdir -p /datos && chown platzito /datos
USER platzito
VOLUME ["/datos"]
EXPOSE 8700
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8700/salud')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8700", "--proxy-headers", "--forwarded-allow-ips", "*"]
