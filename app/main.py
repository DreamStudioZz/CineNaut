import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.config import router as config_router
from app.api.tmdb import router as tmdb_router
from app.api.qas import router as qas_router
from app.api.auth import router as auth_router

app = FastAPI(
    title="CineNaut",
    description="CineNaut - 影视发现与云盘智能转存服务",
    version="1.2.0",
)

# 允许跨域（方便本地前后端调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册 API 路由
app.include_router(auth_router)
app.include_router(config_router)
app.include_router(tmdb_router)
app.include_router(qas_router)

# 静态资源目录配置
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


@app.get("/")
async def root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "Cloud Drive Agent API is running"}


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/{admin_key:path}")
async def admin_entry(admin_key: str):
    """
    捕获 /{admin_key} 路由，支持通过专属密钥直达管理后台
    """
    first_segment = admin_key.strip("/").split("/")[0] if admin_key else ""
    reserved = {"api", "static", "docs", "redoc", "openapi.json", "favicon.ico", "robots.txt"}
    if first_segment in reserved:
        raise HTTPException(status_code=404, detail="Not Found")

    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "Cloud Drive Agent API is running"}

