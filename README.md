# AakashDrishti — DepthWizard

> **Single-View Height Estimation & 3D Flythrough**  
> Smart India Hackathon 2026 · Problem Statement 26175 · ISRO / Department of Space · Theme: Disaster Management

AakashDrishti transforms a single RGB aerial/satellite image into a calibrated elevation map, 3D terrain mesh, and interactive flythrough — supporting disaster-response planning, building-height extraction, slope analysis, and more.

---

## Pipeline Overview

```
Single RGB / GeoTIFF Image
        ↓
Input Detection (PNG · JPG · TIFF · GeoTIFF)
        ↓
Depth Anything V2  +  Depth Pro  (sequential, GPU-memory safe)
        ↓
Edge-Aware Depth Fusion  +  Confidence Map
        ↓
SRTM / DEM / GCP Calibration  (georeferenced input)
        ↓
DSM / rDSM Export  (GeoTIFF)
        ↓
Terrain Mesh  +  RGB Texture
        ↓
Three.js 3D Flythrough  (first-person navigation)
        ↓
Height · Slope · Disaster-Zone Overlays · RMSE/MAE Validation
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 · React 19 · TypeScript · Three.js |
| Backend | Python · FastAPI · Uvicorn |
| ML Models | Depth Anything V2 · Apple Depth Pro |
| Geospatial | rasterio · GDAL · SRTM 30m DEM |
| Image Processing | OpenCV · NumPy · Pillow |
| 3D Mesh Export | trimesh (GLB) |

---

## Prerequisites

| Tool | Minimum Version |
|------|----------------|
| Python | 3.11+ |
| Node.js | 18+ |
| npm | 9+ |
| CUDA (recommended) | 12.x (CPU fallback available) |
| VRAM | 8 GB (RTX 5060-class) |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Blrm123/AakashDrishti.git
cd AakashDrishti
```

### 2. Set up environment variables

```bash
copy .env.example .env
```

Edit `.env` and verify the paths (defaults work out-of-the-box after weight download):

```env
DEPTH_ANYTHING_V2_ENCODER=vitb
DEPTH_ANYTHING_V2_CHECKPOINT=./model/depth_anything_v2_vitb.pth
DEPTH_PRO_CHECKPOINT=./model/ml-depth-pro-main/checkpoints/depth_pro.pt
DEVICE=cuda          # or cpu
CORS_ORIGINS=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

---

### 3. Download model weights

> Model weights are **not** included in the repository (~2.3 GB total).

**Depth Anything V2 — ViT-B checkpoint (~390 MB)**

```bash
# Windows PowerShell
Invoke-WebRequest `
  -Uri "https://huggingface.co/depth-anything/Depth-Anything-V2-Base/resolve/main/depth_anything_v2_vitb.pth" `
  -OutFile "model\depth_anything_v2_vitb.pth"

# or using Python
python -c "
import urllib.request
urllib.request.urlretrieve(
    'https://huggingface.co/depth-anything/Depth-Anything-V2-Base/resolve/main/depth_anything_v2_vitb.pth',
    'model/depth_anything_v2_vitb.pth'
)"
```

**Apple Depth Pro (~1.9 GB)**

```bash
mkdir model\ml-depth-pro-main\checkpoints

# Python download
python -c "
import urllib.request, os
os.makedirs('model/ml-depth-pro-main/checkpoints', exist_ok=True)
urllib.request.urlretrieve(
    'https://ml-site.cdn-apple.com/models/depth-pro/depth_pro.pt',
    'model/ml-depth-pro-main/checkpoints/depth_pro.pt'
)"
```

---

### 4. Backend setup

```bash
cd backend

# Create and activate virtual environment
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Linux / macOS

# Install PyTorch with CUDA (adjust index URL for your CUDA version)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128

# Install backend dependencies
pip install -r requirements.txt

# Install vendored model packages (editable, no-deps to avoid conflicts)
pip install --no-deps -e ..\model\Depth-Anything-V2
pip install --no-deps -e ..\model\ml-depth-pro-main
```

### 5. Frontend setup

```bash
cd frontend
npm install
```

---

## Running the Project

Open **two terminals**:

**Terminal 1 — Backend**
```bash
cd backend
.venv\Scripts\activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir app
```
→ API available at **http://localhost:8000**  
→ Interactive API docs at **http://localhost:8000/docs**

**Terminal 2 — Frontend**
```bash
cd frontend
npm run dev
```
→ App available at **http://localhost:3000**

---

## Usage

1. Open **http://localhost:3000**
2. Upload a **PNG / JPG / TIFF / GeoTIFF** aerial or satellite image
3. The pipeline runs automatically:
   - Depth estimation (DA V2 + Depth Pro, sequential)
   - Edge-aware fusion + confidence map
   - For GeoTIFF: SRTM calibration → metric DSM
   - Terrain mesh generation
4. Explore the result in the **3D viewer**:
   - First-person flythrough (WASD + mouse)
   - Switch overlays: RGB / Elevation / Confidence / Disaster Zones
   - Measure height and slope by clicking the terrain
   - Export DSM as GeoTIFF

---

## Project Structure

```
AakashDrishti/
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routes (upload, pipeline, output)
│   │   ├── core/         # Config, logging
│   │   ├── depth/        # DA V2 & Depth Pro adapters
│   │   ├── fusion/       # Edge-aware depth fusion
│   │   ├── calibration/  # SRTM / GCP calibration
│   │   ├── dsm/          # DSM / rDSM generation & export
│   │   ├── mesh/         # Terrain mesh + GLB export
│   │   ├── pipeline/     # End-to-end pipeline orchestration
│   │   └── geospatial/   # GeoTIFF utilities
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── app/          # Next.js pages
│       ├── components/
│       │   └── viewer/   # Three.js terrain viewer
│       ├── hooks/        # React hooks (pipeline polling, etc.)
│       └── lib/          # API client, utilities
├── model/
│   ├── Depth-Anything-V2/       # DA V2 source (vendored)
│   └── ml-depth-pro-main/       # Depth Pro source (vendored)
├── .env.example
└── README.md
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/project/upload` | Upload image, returns `job_id` |
| `POST` | `/api/pipeline/run/{job_id}` | Start pipeline |
| `GET` | `/api/pipeline/{job_id}` | Poll pipeline status & results |
| `GET` | `/api/pipeline/output/{job_id}/{filename}` | Download output file |
| `GET` | `/api/pipeline/{job_id}/disaster-zones` | Disaster zone overlay |

---

## Notes

- Models are loaded and unloaded **sequentially** to stay within 8 GB VRAM
- Non-georeferenced images produce a **relative DSM (rDSM)** — no metric scale
- GeoTIFF inputs with valid CRS produce a **calibrated metric DSM** via SRTM
- `xFormers not available` warnings are harmless — xFormers is optional
- Never commit `.env`, `data/`, `context/`, or `test-data/` — these are gitignored

---

## License

This project is developed for Smart India Hackathon 2026 (SIH-26175).
