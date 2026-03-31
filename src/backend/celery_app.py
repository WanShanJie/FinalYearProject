"""celery_app.py
Celery application instance — imported by both main.py (to enqueue tasks)
and worker.py (to register and execute tasks).

Keep this file minimal: no imports from main.py or worker.py so that
there is no circular-import risk.
"""

import os
from celery import Celery
from dotenv import load_dotenv

load_dotenv()

# Redis URL — configurable via .env:  REDIS_URL=redis://localhost:6379/0
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "deepfake",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["worker"],  # auto-discover tasks in worker.py
)

celery_app.conf.update(
    # ── Serialisation ─────────────────────────────────────────────────────────
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],

    # ── Time zone ─────────────────────────────────────────────────────────────
    timezone="UTC",
    enable_utc=True,

    # ── Reliability ───────────────────────────────────────────────────────────
    task_track_started=True,       # expose STARTED state so API can report it
    task_acks_late=True,           # re-queue task if worker dies mid-execution
    worker_prefetch_multiplier=1,  # one task at a time; ML models need all RAM

    # ── Memory management ─────────────────────────────────────────────────────
    # Restart each worker child process after N tasks to release memory from
    # PyTorch / OpenCV (common with large ML models on CPU).
    worker_max_tasks_per_child=5,

    # ── Result expiry ─────────────────────────────────────────────────────────
    result_expires=86400,          # keep Celery result in Redis for 24 hours
)
