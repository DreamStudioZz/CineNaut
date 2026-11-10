import secrets
from typing import Optional
from fastapi import HTTPException, Request, status
from app.core.config import get_config


def get_admin_key() -> str:
    """获取当前系统配置的管理员 Key（空字符串表示未设置，不开启访问限制）"""
    cfg = get_config()
    return (cfg.admin_key or "").strip()


def is_admin_required() -> bool:
    """是否开启了管理员权限保护"""
    return bool(get_admin_key())


def extract_client_key(request: Request) -> str:
    """
    从客户端请求中提取 key：
    1. 请求头 X-Admin-Key
    2. 请求头 Authorization: Bearer <key>
    3. URL 查询参数 ?key=... 或 ?admin_key=...
    """
    # 1. 优先读取自定义头
    h_key = request.headers.get("X-Admin-Key") or request.headers.get("x-admin-key")
    if h_key and h_key.strip():
        return h_key.strip()

    # 2. 读取 Authorization
    auth = request.headers.get("Authorization") or request.headers.get("authorization")
    if auth:
        parts = auth.strip().split()
        if len(parts) == 2 and parts[0].lower() in ["bearer", "token"]:
            return parts[1].strip()
        elif len(parts) == 1:
            return parts[0].strip()

    # 3. 读取 URL 查询参数
    q_key = request.query_params.get("key") or request.query_params.get("admin_key")
    if q_key and q_key.strip():
        return q_key.strip()

    return ""


def verify_client_key(provided_key: str) -> bool:
    """校验客户端提供的 key 是否与配置匹配"""
    current_key = get_admin_key()
    if not current_key:
        return True  # 未设置 key，默认所有人允许
    if not provided_key:
        return False
    return secrets.compare_digest(provided_key.strip(), current_key)


def check_admin_access(request: Request) -> bool:
    """检查当前请求是否具有管理员权限"""
    if not is_admin_required():
        return True
    client_key = extract_client_key(request)
    return verify_client_key(client_key)


async def require_admin(request: Request):
    """
    FastAPI 依赖项：保护受限接口
    若开启了管理员保护且校验未通过，直接返回 403 Forbidden
    """
    if not check_admin_access(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限，请通过 ?key=xxx 或 X-Admin-Key 标头提供正确的访问密钥",
        )
