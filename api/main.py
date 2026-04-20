"""Standalone consolidation backend.

Trimmed copy of the full document-extraction API — only the consolidation
and translation routers are registered. Everything else from the parent
project (extraction, chunking, clustering, metadata, jobs, pipeline) is
intentionally omitted because the handoff target is frontend development
of the Consolidation page only.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse

from . import state
from .routers import consolidation, translation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
FRONTEND_DIST = FRONTEND_DIR / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state.startup()
    yield


app = FastAPI(title="Consolidation API (standalone)", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
def serve_frontend():
    dist_index = FRONTEND_DIST / "index.html"
    if dist_index.exists():
        return HTMLResponse(dist_index.read_text())
    return HTMLResponse(
        "<h1>Frontend not built</h1><p>Run <code>npm run dev</code> inside <code>frontend/</code> and open http://localhost:5173.</p>",
        404,
    )


@app.get("/assets/{filepath:path}")
def serve_assets(filepath: str):
    file_path = FRONTEND_DIST / "assets" / filepath
    if not file_path.exists() or not file_path.is_file():
        return JSONResponse({"error": "not found"}, 404)
    return FileResponse(file_path)


@app.get("/{filename}")
def serve_root_static(filename: str):
    file_path = FRONTEND_DIST / filename
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    return JSONResponse({"error": "not found"}, 404)


@app.get("/api/v1/documents")
def list_documents():
    return state.documents


app.include_router(consolidation.router, prefix="/api/v1")
app.include_router(translation.router, prefix="/api/v1")
