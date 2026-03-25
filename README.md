# Final Year Project: Deepfake Verification & Monitoring System

A comprehensive monitoring and detection platform designed to detect deepfakes on social media sites (YouTube, TikTok, Facebook) using a Chrome extension for real-time interception and a React Dashboard for visualization and historical analysis.

## 🚀 System Architecture

- **Chrome Extension**: Intercepts video/thumbnail content on social media, calculates hashes, and coordinates with the service worker.
- **Python Backend**: Fast API based server handling analysis results, blocklists, and thumbnail pHash matching.
- **React Dashboard**: Professional monitoring dashboard for managing detections and viewing live capture metrics.

## 🛠️ Technology Stack

### Frontend (Dashboard)
- **Framework**: React 18+
- **Styling**: TailwindCSS & Vanilla CSS Modules
- **Charts**: Recharts (Monitoring-grade Line/Area charts)
- **Routing**: React Router 6

### Chrome Extension
- **Logic**: Vanilla Javascript
- **Communication**: Chrome Runtime Messaging
- **Detection**: Image hashing (aHash/pHash) and Video ID matching

### Backend
- **Framework**: FastAPI (Python)
- **Database**: SQLite / SQLAlchemy
- **Analysis**: OpenCV, Python image hashing utilities

---

## 🛠️ Setup & Installation

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Python 3.10+](https://www.python.org/)

### 2. Dashboard & Frontend Setup
Navigate to the root directory and install dependencies:
```bash
npm install
```

### 3. Backend Setup
Navigate to the `src/backend` directory and install dependencies:
```bash
cd src/backend
pip install -r requirements.txt
```

---

## 🏃 Running the System

To get the full system working, you need to run three components simultaneously:

### Step 1: Start the Backend (API)
From the `src/backend` directory:
```bash
# Using uvicorn
python -m uvicorn main:app --reload --port 8000
```
*Port 8000 must be free for the dashboard to connect.*

### Step 2: Start the Dashboard
From the root directory:
```bash
# Using vite dev server
npm run dev
```
*By default, the dashboard will run at http://localhost:5173.*

### Step 3: Install the Extension
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `deepfake-extension-frontend` folder from the project directory.

---

## 📊 Dashboard Overview
The new dashboard is organized into professional monitoring rows:
- **Live Capture Feed**: Horizontal grid of recent social media interceptions.
- **Detection Trends**: Recharts area chart visualizing scan volume vs detections.
- **Threat Snapshot**: Core breakdown of Fake, Suspicious, and Inconclusive media.
- **Activity Timeline**: History logs with thumbnail previews of analyzed content.

## 🛡️ Important Notes
- **requirements.txt**: This file is only for Python (Backend) dependencies. Frontend packages like `recharts` are managed by `package.json` in the root.
- **Network Conflicts**: Ensure ports 5173 (Vite) and 8000 (FastAPI) are available.
- **Syncing**: If you add new blocked videos, the extension will automatically pick them up through the service worker sync.
