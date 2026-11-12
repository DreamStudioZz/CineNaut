import asyncio
from typing import Optional

import httpx

from app.core.config import get_config

# 共享连接池：按上游拆分，避免每次请求都新建 TCP/TLS 连接。
# TMDB 可能走用户配置的代理；QAS 通常在本机/局域网，强制直连；LLM 保持系统默认环境。
LIMITS = httpx.Limits(
    max_connections=50,
    max_keepalive_connections=20,
    keepalive_expiry=30.0,
)

_lock = asyncio.Lock()
_tmdb_client: Optional[httpx.AsyncClient] = None
_tmdb_proxy: Optional[str] = None
_qas_client: Optional[httpx.AsyncClient] = None
_llm_client: Optional[httpx.AsyncClient] = None


def _configured_proxy() -> str:
    return (get_config().proxy or "").strip()


def _build_tmdb_client(proxy: str) -> httpx.AsyncClient:
    kwargs = {
        "timeout": 15.0,
        "follow_redirects": True,
        "limits": LIMITS,
    }
    if proxy:
        kwargs["proxy"] = proxy
    return httpx.AsyncClient(**kwargs)


def _build_qas_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=30.0,
        follow_redirects=True,
        trust_env=False,
        limits=LIMITS,
    )


def _build_llm_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=30.0,
        follow_redirects=True,
        limits=LIMITS,
    )


def _ensure_tmdb_client_locked() -> httpx.AsyncClient:
    """调用方必须已持有 _lock。"""
    global _tmdb_client, _tmdb_proxy
    if _tmdb_client is None:
        proxy = _configured_proxy()
        try:
            _tmdb_client = _build_tmdb_client(proxy)
            _tmdb_proxy = proxy
        except Exception as e:
            print(f"[HTTP] TMDB 客户端初始化失败，已回退为直连: {e}")
            _tmdb_client = httpx.AsyncClient(
                timeout=15.0,
                follow_redirects=True,
                limits=LIMITS,
            )
            _tmdb_proxy = ""
    return _tmdb_client


def _ensure_qas_client_locked() -> httpx.AsyncClient:
    global _qas_client
    if _qas_client is None:
        _qas_client = _build_qas_client()
    return _qas_client


def _ensure_llm_client_locked() -> httpx.AsyncClient:
    global _llm_client
    if _llm_client is None:
        _llm_client = _build_llm_client()
    return _llm_client


async def init_http_clients() -> None:
    """在 FastAPI lifespan 启动时预热共享连接池。"""
    async with _lock:
        _ensure_tmdb_client_locked()
        _ensure_qas_client_locked()
        _ensure_llm_client_locked()


async def close_http_clients() -> None:
    """在 FastAPI lifespan 关闭时释放共享连接池。"""
    global _tmdb_client, _qas_client, _llm_client
    async with _lock:
        clients = [c for c in (_tmdb_client, _qas_client, _llm_client) if c is not None]
        _tmdb_client = None
        _qas_client = None
        _llm_client = None
    for client in clients:
        try:
            await client.aclose()
        except Exception as e:
            print(f"[HTTP] 关闭连接池失败: {e}")


async def get_tmdb_client() -> httpx.AsyncClient:
    async with _lock:
        return _ensure_tmdb_client_locked()


async def get_qas_client() -> httpx.AsyncClient:
    async with _lock:
        return _ensure_qas_client_locked()


async def get_llm_client() -> httpx.AsyncClient:
    async with _lock:
        return _ensure_llm_client_locked()


async def reset_tmdb_client(force: bool = False) -> None:
    """代理配置变化后重建 TMDB 客户端；旧连接池在新客户端就绪后关闭。"""
    global _tmdb_client, _tmdb_proxy
    proxy = _configured_proxy()

    async with _lock:
        if not force and _tmdb_client is not None and proxy == _tmdb_proxy:
            return
        try:
            new_client = _build_tmdb_client(proxy)
        except Exception as e:
            print(f"[HTTP] 重建 TMDB 客户端失败，保留旧连接池: {e}")
            return
        old_client = _tmdb_client
        _tmdb_client = new_client
        _tmdb_proxy = proxy

    if old_client is not None:
        await old_client.aclose()
