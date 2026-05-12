# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

A deepfake detection and monitoring system consisting of three interconnected components:
1. **Chrome Extension** — real-time monitoring on YouTube, Facebook, TikTok
2. **React Dashboard** — analytics, media review, blocklist management
3. **Python FastAPI Backend** — ML-based deepfake analysis, auth, database

## Development Setup & Commands

### Frontend (React Dashboard)
```bash
npm install          # Install dependencies (run from repo root)
npm run dev          # Start Vite dev server at http://localhost:5173
npm run build        # Production build
npm run preview      # Preview production build
```

### Backend (FastAPI)
```bash
cd src/backend
pip install -r requirements.txt    # Install Python deps (Python 3.10+ required)
python -m uvicorn main:app --reload --port 8000
```

### Chrome Extension
Load unpacked from the `deepfake-extension-frontend/` folder in `chrome://extensions` (Developer mode on).

### Environment Configuration
Backend requires `src/backend/.env` with:
- `DB_*` — MySQL connection (host: 127.0.0.1, db: fyp_deepfake)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth
- `JWT_SECRET_KEY` — token signing
- `SMTP_*` — Gmail SMTP for email verification/MFA
- `FRONTEND_BASE_URL` / `BASE_BACKEND_URL` — cross-origin URLs

## Architecture

### Backend (`src/backend/`)
- **`main.py`** — FastAPI app with all route definitions; includes auth, extension pairing, media analysis, blocklist, and user management endpoints
- **`models.py`** — SQLAlchemy ORM models: `User`, `MediaAnalysis`, `LinkedExtension`, `GlobalBlocklist`, `MfaChallenge`, `TrustedDevice`, etc.
- **`schemas.py`** — Pydantic request/response schemas
- **`auth.py`** — JWT creation/validation, password hashing
- **`oauth_routes.py`** — Google/X OAuth 2.0 flows via Authlib
- **`opencv_pipeline.py`** — Core analysis pipeline: YuNet face detection (ONNX), face tracking with IoU, quality gating (blur/brightness/size), deduplication, outputs 32-frame sequences for deepfake models
- **`scripts/altfreezing_service.py`** — AltFreezing deepfake detection model wrapper
- **`scripts/dfdc_model.py`** — DFDC dataset-trained XceptionNet wrapper
- **`checkpoints/`** — Pre-trained model weights (`.pth` files, not to be modified)
- **`face_detection_yunet_2023mar.onnx`** — YuNet face detector

### Frontend (`src/`)
- **`App.jsx`** — Root router; splits into public routes and protected routes wrapped in `RequireAuth`
- **`pages/`** — Full-page views (Dashboard, MediaAnalysis, BlocklistManager, Settings, ExtensionConnect, auth pages)
- **`components/system/`** — Main app shell: `SystemLayout`, `SystemHeader`, `SystemSidebar`
- **`api/auth.js`** — All backend API calls (auth, user profile, analyses, etc.)
- Charts use **Recharts** (AreaChart for trends); styling via **TailwindCSS**

### Chrome Extension (`deepfake-extension-frontend/`)
- **`service_worker.js`** — Background: handles tab capture, sends screenshots to `POST /api/analysis/capture`, manages auth tokens and extension state
- **`content.js`** — Content script: monitors DOM for `<img>`/`<video>` elements, computes aHash/pHash fingerprints, queries local IndexedDB blocklist
- **`idb.js`** — IndexedDB helpers for local blocklist cache
- **`offscreen.js`** — Uses `tabCapture` API (requires offscreen document in MV3)
- **`popup.js`** — Extension popup UI: real-time protection toggle, manual analyze button

### Data Flow
1. Extension content script detects media → computes hash → checks local IndexedDB blocklist
2. Service worker captures screenshot → POSTs to backend `/api/analysis/capture`
3. Backend runs `opencv_pipeline.py` (face detection + quality gating) → feeds 32-frame sequences to deepfake models → stores result in `MediaAnalysis` table
4. Dashboard fetches results from `/api/media/analyses` and `/api/analysis/results` → renders in charts/timeline

### Authentication Flow
Registration → email OTP verification → login → optional MFA (email OTP) → JWT issued → device trust (30-day skip MFA). OAuth via Google/X uses Authlib; callback redirects to `http://localhost:5173/oauth/callback`.

### Extension Pairing
Dashboard generates a pairing code → extension redeems at `/api/extension/redeem-link` → creates `LinkedExtension` record → extension uses the user's JWT for subsequent API calls.

## Key Technical Notes

- Backend uses **MySQL** (not SQLite) — ensure MySQL is running locally before starting the backend
- Deepfake models run on **CPU** (`torch 2.1.0+cpu`) — inference is slow; `opencv_pipeline.py` implements quality gating to minimize frames sent to model
- Extension uses **Manifest V3** — background logic must be in service worker (no persistent background page); offscreen document required for `tabCapture`
- The `third_party/` directory contains vendored deepfake detection model code — treat as read-only
- `src/backend/venv/` is the local Python virtual environment — not committed to git
