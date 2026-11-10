from typing import Optional
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from app.core.auth import (
    check_admin_access,
    extract_client_key,
    get_admin_key,
    is_admin_required,
    verify_client_key,
)
from app.core.config import get_config

router = APIRouter(prefix="/api/auth", tags=["auth"])


class VerifyKeyPayload(BaseModel):
    key: Optional[str] = Field(default="", description="待检验的管理员密钥")


@router.get("/status")
async def get_auth_status(request: Request):
    """
    获取当前系统权限状态：
    - require_admin: 服务端是否配置了管理员 key
    - is_admin: 当前请求是否已获得管理员授权
    - llm_enabled: 是否启用了 AI 质检
    """
    cfg = get_config()
    required = is_admin_required()
    is_admin = check_admin_access(request)

    return {
        "success": True,
        "require_admin": required,
        "is_admin": is_admin,
        "llm_enabled": cfg.llm_enabled,
    }


@router.post("/verify")
async def verify_key(payload: VerifyKeyPayload):
    """校验指定的 key 是否正确"""
    is_valid = verify_client_key(payload.key or "")
    return {
        "success": True,
        "valid": is_valid,
        "message": "验证通过，已获得管理员权限" if is_valid else "管理员密钥不正确，请重新输入",
    }
