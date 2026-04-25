# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
RUN pip install -e .
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8100
CMD ["uvicorn", "vaa_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
