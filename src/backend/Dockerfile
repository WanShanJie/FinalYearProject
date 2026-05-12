# Use an official PyTorch + CUDA base image or Python slim image
# We'll use a standard Python 3.10 slim image which is common for FastAPI backends,
# but if you use heavy GPU inference, you'll likely change this to nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive

# Set the working directory
WORKDIR /app

# Install system dependencies required by OpenCV and other ML libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .

# Install dependencies (ignoring the cache so we don't store pip cache in the image)
# We use --prefer-binary to speed up builds
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --prefer-binary \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose port 8000 for FastAPI
EXPOSE 8000

# Start command (we default to FastAPI, but Compose will override this for Celery)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
