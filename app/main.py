import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.config import router as config_router
from app.api.tmdb import router as tmdb_router
from app.api.qas import router as qas_router
from app.api.auth import router as auth_router
from app.core.http_clients import close_http_clients, init_http_clients


class CacheAndSecurityHeadersMiddleware:
    """纯 ASGI 中间件：只修改响应头，不缓冲响应体，兼容 SSE。"""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "x-content-type-options" not in headers:
                    headers["x-content-type-options"] = "nosniff"
                if "x-frame-options" not in headers:
                    headers["x-frame-options"] = "DENY"
                if "referrer-policy" not in headers:
                    headers["referrer-policy"] = "no-referrer"
                if path.startswith("/static/") and not path.endswith(".html"):
                    if "cache-control" not in headers:
                        headers["cache-control"] = "public, max-age=31536000, immutable"
                elif not path.startswith("/api/"):
                    # HTML 入口不缓存，确保 ?v= 版本更新能生效
                    if "cache-control" not in headers:
                        headers["cache-control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_wrapper)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_http_clients()
    yield
    await close_http_clients()


app = FastAPI(
    title="CineNaut",
    description="CineNaut - 影视发现与云盘智能转存服务",
    version="1.2.0",
    lifespan=lifespan,
)

# 允许跨域（方便本地前后端调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 压缩静态资源与 JSON 响应（SSE / 图片等类型由 Starlette 默认排除）
app.add_middleware(GZipMiddleware, minimum_size=1024)

# 静态资源长缓存 + 基础安全响应头（纯 ASGI，不触碰响应体）
app.add_middleware(CacheAndSecurityHeadersMiddleware)

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

