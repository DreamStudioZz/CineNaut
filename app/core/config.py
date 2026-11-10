import json
import os
from pathlib import Path
from pydantic import BaseModel, Field


class AppConfig(BaseModel):
    # TMDB 配置
    tmdb_api_key: str = Field(default="", description="TMDB API 密钥 (v3 Key 或 v4 Token)")
    tmdb_base_url: str = Field(default="https://api.themoviedb.org", description="TMDB API 基址 (支持反代)")
    tmdb_image_base_url: str = Field(default="https://image.tmdb.org", description="TMDB 图片基址")
    proxy: str = Field(default="", description="HTTP/SOCKS 代理地址 (例如 http://127.0.0.1:7890)")

    # Quark-Auto-Save (QAS) 服务配置
    qas_base_url: str = Field(default="http://localhost:5005", description="QAS 服务接口基地址")
    qas_token: str = Field(default="", description="QAS API Token")

    # 管理员安全访问密钥 (可通过环境变量 ADMIN_KEY 或 config.json 设置，若设置则任务列表与系统设置需提供 key 才能访问)
    admin_key: str = Field(default="", description="管理员访问密钥，若配置则访问任务列表与系统设置需鉴权")

    # AI 智能质检与排序配置 (OpenAI 兼容接口，支持 DeepSeek, OpenAI, Kimi, 通义千问, Ollama 等)
    llm_enabled: bool = Field(default=True, description="是否启用 AI 智能质检与排序")
    llm_base_url: str = Field(default="https://api.deepseek.com/v1", description="OpenAI 兼容 API 基础地址")
    llm_api_key: str = Field(default="", description="大模型 API 密钥")
    llm_model: str = Field(default="deepseek-chat", description="大模型模型名称")

    # 路径规则配置 (支持 {片名}, {剧名}, {年份}, {季数} 等变量)
    path_movie: str = Field(default="nas/movie/{片名} ({年份})", description="电影保存路径")
    path_tv: str = Field(default="nas/TV/{剧名} ({年份})/{剧名} - S{季数}", description="剧集保存路径")
    path_anime: str = Field(default="nas/动画/{剧名} ({年份})/{剧名} - S{季数}", description="动画保存路径")
    path_variety: str = Field(default="nas/综艺/{剧名} ({年份})/{剧名} - S{季数}", description="综艺保存路径")
    path_doc: str = Field(default="纪录片/{剧名} ({年份})/{剧名} - S{季数}", description="纪录片保存路径")


CONFIG_DIR = Path(os.getenv("DATA_DIR", "data"))
CONFIG_FILE = CONFIG_DIR / "config.json"


def get_config() -> AppConfig:
    env_admin_key = os.getenv("ADMIN_KEY", "").strip()
    if not CONFIG_FILE.exists():
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        default_cfg = AppConfig()
        if env_admin_key:
            default_cfg.admin_key = env_admin_key
        save_config(default_cfg)
        return default_cfg
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            cfg = AppConfig(**data)
            # 环境变量 ADMIN_KEY 优先
            if env_admin_key:
                cfg.admin_key = env_admin_key
            return cfg
    except Exception:
        cfg = AppConfig()
        if env_admin_key:
            cfg.admin_key = env_admin_key
        return cfg


def save_config(config: AppConfig) -> AppConfig:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config.model_dump(), f, ensure_ascii=False, indent=2)
    return config
