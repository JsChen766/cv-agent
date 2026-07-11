FROM python:3.12-slim

WORKDIR /app

# Install system deps (for asyncpg, bcrypt, pypdf)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps - core first, then ML stack (CPU-only torch)
COPY pyproject.toml .
RUN pip install --no-cache-dir -e "." && \
    pip install --no-cache-dir --force-reinstall --index-url https://download.pytorch.org/whl/cpu \
    torch torchvision torchaudio

# Copy source
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
