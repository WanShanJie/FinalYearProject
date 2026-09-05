# Final Year Project: Deepfake Verification & Monitoring System

This repository contains the latest development version of the Context-Aware
Deepfake Verification system.

A deepfake detection and monitoring system with three parts:

- React dashboard for analytics, media review, blocklist management, and user settings
- FastAPI backend for authentication, extension pairing, media analysis, and database access
- Chrome extension for monitoring YouTube, Facebook, and TikTok media in the browser

## Prerequisites

Install these before running the project:

- Node.js 18+
- Python 3.10+
- MySQL 8.0+
- Redis, required for queued video analysis with Celery
- Docker Desktop, only if using the Docker commands
- Google Chrome, for loading the extension

On Windows, add `node`, `npm`, `python`, `pip`, `mysql`, `docker`, and
`docker compose` to `PATH`, or use the corresponding application terminals.

## Environment File

Create `src/backend/.env` before starting the backend.

For local development:

```env
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=fyp_deepfake

REDIS_URL=redis://localhost:6379/0

JWT_SECRET_KEY=change_this_to_a_long_random_secret
FRONTEND_BASE_URL=http://localhost:5173
BASE_BACKEND_URL=http://127.0.0.1:8000

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_gmail_app_password
SMTP_FROM=your_email@gmail.com
```

For Docker Compose, the compose file overrides the database and Redis host settings:

```env
JWT_SECRET_KEY=change_this_to_a_long_random_secret
FRONTEND_BASE_URL=http://localhost:5173
BASE_BACKEND_URL=http://127.0.0.1:8000

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_gmail_app_password
SMTP_FROM=your_email@gmail.com
```

The backend creates database tables automatically when it starts.

Do not commit `src/backend/.env`. The Google OAuth and SMTP values are only
needed for the related login and email features; local username/password
testing can run without OAuth configuration.

## Run Locally With CMD / PowerShell

Open separate terminals for each component.

### 1. Install Dashboard Dependencies

Run from the project root:

```bash
npm install
```

### 2. Create and Prepare a Python Environment

Run these commands from the project root. A virtual environment keeps the
backend packages separate from the system Python installation.

```bash
python -m venv src/backend/venv
```

PowerShell:

```powershell
& .\src\backend\venv\Scripts\Activate.ps1
```

CMD:

```cmd
src\backend\venv\Scripts\activate.bat
```

Install the backend dependencies after activation:

```bash
cd src/backend
pip install -r requirements.txt
```

If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process
Bypass` in that terminal and activate the environment again.

### 3. Start MySQL

Make sure MySQL is running locally and create the database named in `.env`:

```sql
CREATE DATABASE fyp_deepfake;
```

If you want to restore the included backup, run from the project root:

```bash
mysql -u root -p fyp_deepfake < local_backup.sql
```

### 4. Start Redis

Start Redis locally on port `6379`.

If you do not have Redis installed locally, you can run only Redis with Docker:

```bash
docker run --name deepfake_redis_local -p 6379:6379 redis:7-alpine
```

If the container already exists, start it again with:

```bash
docker start deepfake_redis_local
```

### 5. Start the Backend API

Run from `src/backend`:

```bash
cd src/backend
python -m uvicorn main:app --reload --port 8000
```

Backend URL:

```text
http://127.0.0.1:8000
```

Check that the API is reachable by opening `http://127.0.0.1:8000/docs`.

### 6. Start the Celery Worker

Run from `src/backend` in another terminal:

```bash
cd src/backend
celery -A worker worker --loglevel=info --concurrency=1 --pool=solo
```

This worker handles queued video/deepfake analysis jobs.

### 7. Start the React Dashboard

Run from the project root:

```bash
npm run dev
```

Dashboard URL:

```text
http://localhost:5173
```

### 8. Load the Chrome Extension

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `deepfake-extension-frontend` folder.

The extension expects the backend at:

```text
http://127.0.0.1:8000
```

After loading the extension, sign in through the dashboard and use the
extension pairing workflow before testing browser monitoring. If the
extension files change, return to `chrome://extensions/` and click Reload on
the extension card.

## Run With Docker Compose

The current `docker-compose.yml` starts all application services:

- FastAPI backend on port `8000`
- Celery worker
- React/Vite dashboard on port `5173`
- Redis, exposed on host port `6380`
- MySQL, exposed on host port `3307`

Docker Compose uses the database name `deepfake_db` and password `password`
inside the MySQL container. The `DB_*` and `REDIS_URL` values in the Compose
file override those connection settings from `src/backend/.env` for the
containerized backend and worker.

### 1. Build and Start Docker Services

Run from the project root:

```bash
docker compose up --build
```

Or run in the background:

```bash
docker compose up --build -d
```

Open the dashboard:

```text
http://localhost:5173
```

The Docker frontend mounts the source files and runs `npm install` when it
starts, so a separate local `npm install` is not required for this workflow.

### 2. Check Docker Logs

```bash
docker compose logs -f backend
docker compose logs -f celery_worker
docker compose logs -f db
docker compose logs -f redis
```

### 3. Stop Docker Services

```bash
docker compose down
```

To stop services and remove Docker volumes, including MySQL data:

```bash
docker compose down -v
```

Only use `docker compose down -v` when you are okay deleting the Docker database data.

### 4. Load the Extension

The extension can still be loaded from the local
`deepfake-extension-frontend` folder in Chrome. Because the extension calls
`http://127.0.0.1:8000`, keep the backend port published by Compose.

## Useful Commands

Frontend:

```bash
npm run dev
npm run build
npm run preview
```

Backend:

```bash
cd src/backend
python -m uvicorn main:app --reload --port 8000
celery -A worker worker --loglevel=info --concurrency=1 --pool=solo
```

Docker:

```bash
docker compose up --build
docker compose up --build -d
docker compose logs -f backend
docker compose down
```

## Default Ports

| Component | Local URL / Port |
| --- | --- |
| React dashboard | `http://localhost:5173` |
| FastAPI backend | `http://127.0.0.1:8000` |
| Local MySQL | `127.0.0.1:3306` |
| Local Redis | `localhost:6379` |
| Docker MySQL host port | `127.0.0.1:3307` |
| Docker Redis host port | `localhost:6380` |

## Notes

- Keep `src/backend/checkpoints/`, `src/backend/third_party/`, and model files in place because the ML pipeline depends on them.
- The backend uses MySQL through SQLAlchemy and PyMySQL.
- CPU inference can be slow, especially for uploaded videos.
- Ports `5173` and `8000` must be free for the dashboard and extension to connect normally.
- Do not run the local backend and the Docker backend at the same time unless
  you intentionally change their ports.

## Acknowledgements

This project was developed as a final year project with the support and
guidance of the project supervisor, academic staff, evaluators, and project
team members who contributed to its research, implementation, testing, and
documentation.

We acknowledge the authors and maintainers of the open-source technologies
used in this system, including React, Vite, Tailwind CSS, FastAPI, SQLAlchemy,
PyTorch, OpenCV, MediaPipe, Celery, Redis, MySQL, and the Python ecosystem.
We also acknowledge the researchers and dataset/model contributors whose
published work informed the deepfake detection components, including the
AltFreezing and DFDC-related model implementations. Their software,
documentation, and research made this project possible.

## Troubleshooting

### Celery Cannot Connect to Redis

If Celery shows this error:

```text
Cannot connect to redis://localhost:6379/0
```

Redis is not running on port `6379`. Start Redis first:

```bash
docker run --name deepfake_redis_local -p 6379:6379 redis:7-alpine
```

If that container already exists:

```bash
docker start deepfake_redis_local
```

Then rerun the worker:

```bash
cd src/backend
celery -A worker worker --loglevel=info --concurrency=1 --pool=solo
```

If you are using the Redis container from `docker compose`, it is exposed on host port `6380`, so set this in `src/backend/.env` for local Celery:

```env
REDIS_URL=redis://localhost:6380/0
```
