from typing import Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from app.core.auth import require_admin
from app.core.config import AppConfig, get_config, save_config
from app.core.http_clients import reset_tmdb_client
from app.core.llm_evaluator import verify_llm_connection

router = APIRouter(prefix="/api/config", tags=["config"])


class TestLlmPayload(BaseModel):
    base_url: Optional[str] = Field(default=None, description="API 基础地址")
    api_key: Optional[str] = Field(default=None, description="API 密钥")
    model: Optional[str] = Field(default=None, description="模型名称")


def _config_view(cfg: AppConfig) -> dict:
    """对外配置视图：密钥一律脱敏，只暴露是否已配置"""
    data = cfg.model_dump()
    data["has_tmdb_api_key"] = bool(cfg.tmdb_api_key.strip())
    data["has_qas_token"] = bool(cfg.qas_token.strip())
    data["has_llm_api_key"] = bool(cfg.llm_api_key.strip())
    data["tmdb_api_key"] = ""
    data["qas_token"] = ""
    data["llm_api_key"] = ""
    data["admin_key"] = ""
    return data


@router.get("", dependencies=[Depends(require_admin)])
async def read_config():
    """读取当前系统配置（密钥脱敏）"""
    return _config_view(get_config())


@router.post("", dependencies=[Depends(require_admin)])
async def update_config(config: AppConfig):
    """保存并更新系统配置；未提交字段与留空密钥保持原值"""
    current = get_config().model_dump()
    incoming = config.model_dump()

    # 前端未提交的字段（如 admin_key / tmdb_image_base_url）保持原值
    for field, value in incoming.items():
        if field not in config.model_fields_set:
            incoming[field] = current[field]

    # 脱敏表单里密钥留空 = 不修改，避免误清空
    for secret in ("tmdb_api_key", "qas_token", "llm_api_key", "admin_key"):
        if not str(incoming.get(secret) or "").strip():
            incoming[secret] = current[secret]

    saved = save_config(AppConfig(**incoming))

    # 代理变化后重建 TMDB 共享连接池，让新请求立即生效
    old_proxy = str(current.get("proxy") or "").strip()
    new_proxy = str(saved.proxy or "").strip()
    if old_proxy != new_proxy:
        try:
            await reset_tmdb_client()
        except Exception as e:
            print(f"[Config] 重置 TMDB 客户端失败: {e}")

    return _config_view(saved)


@router.post("/test-llm", dependencies=[Depends(require_admin)])
async def test_llm_endpoint(payload: Optional[TestLlmPayload] = None):
    """测试大模型 API 连通性（受管理员密钥保护）"""
    if payload:
        return await verify_llm_connection(
            base_url=payload.base_url,
            api_key=payload.api_key,
            model=payload.model,
        )
    return await verify_llm_connection()
