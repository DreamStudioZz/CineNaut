import datetime
import time
from typing import Any, Dict, List, Optional
import httpx
from app.core.config import get_config

GENRE_MAP: Dict[int, str] = {
    # 电影类型
    28: "动作",
    12: "冒险",
    16: "动画",
    35: "喜剧",
    80: "犯罪",
    99: "纪录片",
    18: "剧情",
    10751: "家庭",
    14: "奇幻",
    36: "历史",
    27: "恐怖",
    10402: "音乐",
    9648: "悬疑",
    10749: "爱情",
    878: "科幻",
    10770: "电视电影",
    53: "惊悚",
    10752: "战争",
    37: "西部",
    # 剧集类型
    10759: "动作冒险",
    10762: "儿童",
    10763: "新闻",
    10764: "真人秀",
    10765: "科幻奇幻",
    10766: "肥皂剧",
    10767: "脱口秀",
    10768: "战争政治",
}

# 简单内存缓存：key -> (timestamp, data)
_CACHE: Dict[str, tuple[float, Any]] = {}
CACHE_TTL = 300  # 缓存 5 分钟


def _get_http_client() -> httpx.AsyncClient:
    cfg = get_config()
    kwargs: Dict[str, Any] = {
        "timeout": 15.0,
        "follow_redirects": True,
    }
    if cfg.proxy and cfg.proxy.strip():
        kwargs["proxy"] = cfg.proxy.strip()
    return httpx.AsyncClient(**kwargs)


def _get_headers_and_params(params: Optional[Dict[str, Any]] = None) -> tuple[Dict[str, str], Dict[str, Any]]:
    cfg = get_config()
    key = cfg.tmdb_api_key.strip()
    headers = {"Accept": "application/json"}
    query_params: Dict[str, Any] = params.copy() if params else {}

    # 判断是否为 v4 Bearer Token 还是 v3 API Key (通常 v4 token 很长以 ey 开头)
    if key.startswith("ey") or len(key) > 50:
        headers["Authorization"] = f"Bearer {key}"
    else:
        query_params["api_key"] = key

    query_params["language"] = "zh-CN"
    return headers, query_params


async def verify_tmdb_connection() -> Dict[str, Any]:
    """验证 TMDB 连通性及密钥有效性"""
    cfg = get_config()
    if not cfg.tmdb_api_key.strip():
        return {
            "success": False,
            "message": "尚未配置 TMDB API 密钥，请先在下方输入保存",
            "latency_ms": 0,
        }

    base_url = cfg.tmdb_base_url.rstrip("/")
    url = f"{base_url}/3/authentication"
    headers, params = _get_headers_and_params()

    start_time = time.time()
    try:
        async with _get_http_client() as client:
            resp = await client.get(url, headers=headers, params=params)
            latency = int((time.time() - start_time) * 1000)

            if resp.status_code == 200:
                return {
                    "success": True,
                    "message": f"TMDB 连通成功！延迟 {latency}ms",
                    "latency_ms": latency,
                }
            else:
                data = resp.json() if "application/json" in resp.headers.get("Content-Type", "") else {}
                err_msg = data.get("status_message", f"HTTP {resp.status_code}")
                return {
                    "success": False,
                    "message": f"验证失败 ({err_msg})",
                    "latency_ms": latency,
                }
    except Exception as e:
        latency = int((time.time() - start_time) * 1000)
        return {
            "success": False,
            "message": f"网络连接异常: {str(e)}",
            "latency_ms": latency,
        }


def _format_tmdb_item(item: Dict[str, Any], default_is_tv: bool = False) -> Dict[str, Any]:
    media_type = item.get("media_type")
    is_tv = (media_type == "tv") if media_type else default_is_tv
    title = item.get("name") if is_tv else item.get("title")
    original_title = item.get("original_name") if is_tv else item.get("original_title")
    release_date = item.get("first_air_date") if is_tv else item.get("release_date")
    year = release_date.split("-")[0] if release_date else ""
    vote_avg = round(float(item.get("vote_average", 0.0)), 1)
    genre_ids = item.get("genre_ids", [])
    genres = [GENRE_MAP[gid] for gid in genre_ids if gid in GENRE_MAP]
    genre_text = " / ".join(genres[:3]) if genres else ("剧集" if is_tv else "电影")

    poster_path = item.get("poster_path")
    poster_url = f"/api/tmdb/image?path={poster_path}" if poster_path else ""

    backdrop_path = item.get("backdrop_path")
    backdrop_url = f"/api/tmdb/image?path={backdrop_path}&size=w780" if backdrop_path else ""

    return {
        "id": item.get("id"),
        "title": title or original_title or "未知片名",
        "original_title": original_title or "",
        "year": year,
        "rating": vote_avg,
        "genres": genre_text,
        "overview": item.get("overview", ""),
        "poster_url": poster_url,
        "backdrop_url": backdrop_url,
        "raw_poster_path": poster_path or "",
        "raw_backdrop_path": backdrop_path or "",
        "media_type": "tv" if is_tv else "movie",
    }


async def discover_media(category: str = "popular_movie", region: str = "all", page: int = 1) -> Dict[str, Any]:
    """
    影视发现数据获取
    category:
      popular_movie (热门电影), latest_movie (最新电影), top_movie (高分佳片), cold_movie (冷门佳片)
      popular_tv (热门剧集), popular_anime (热门动画), popular_variety (热门综艺), popular_doc (热门纪录片)
    region:
      all (全部), zh (华语), en (欧美), ja (日本), ko (韩国)
    """
    cfg = get_config()
    if not cfg.tmdb_api_key.strip():
        return {
            "items": [],
            "page": 1,
            "total_pages": 0,
            "error": "未配置 TMDB API 密钥，请前往系统配置设置",
        }

    cache_key = f"{category}:{region}:{page}"
    now = time.time()
    if cache_key in _CACHE:
        ts, data = _CACHE[cache_key]
        if now - ts < CACHE_TTL:
            return data

    base_url = cfg.tmdb_base_url.rstrip("/")
    params: Dict[str, Any] = {"page": page}
    is_tv = False
    today = datetime.date.today()

    # 1. 语言过滤映射 (使用 discover 端点时，with_original_language 方能完全生效)
    lang_map = {
        "zh": "zh|cn",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
    }
    if region in lang_map:
        params["with_original_language"] = lang_map[region]

    # 2. 类别映射与精准筛选逻辑 (全部统一使用强大的 discover 端点)
    if category == "popular_movie":
        endpoint = "/3/discover/movie"
        params["sort_by"] = "popularity.desc"
        params["vote_count.gte"] = 25

    elif category == "latest_movie":
        # 最新电影：严格限定上映日期在最近 10 个月内且已上映，彻底杜绝老片修复重映（如 1993 圣诞夜惊魂）与遥远未来未上映片
        endpoint = "/3/discover/movie"
        params["sort_by"] = "popularity.desc"
        params["primary_release_date.lte"] = today.isoformat()
        params["primary_release_date.gte"] = (today - datetime.timedelta(days=300)).isoformat()
        params["vote_count.gte"] = 10

    elif category == "top_movie":
        # 高分佳片：按评分降序，设定充足的评分基数以防刷分，并配合选定语言过滤
        endpoint = "/3/discover/movie"
        params["sort_by"] = "vote_average.desc"
        params["vote_count.gte"] = 300
        params["vote_average.gte"] = 7.8

    elif category == "cold_movie":
        # 冷门佳片：限定现代（近 15 年），评分较高 (>=7.5) 且小众关注 (60 <= 票数 <= 500)
        endpoint = "/3/discover/movie"
        params["sort_by"] = "vote_average.desc"
        params["primary_release_date.gte"] = (today - datetime.timedelta(days=365 * 15)).isoformat()
        params["vote_average.gte"] = 7.5
        params["vote_count.gte"] = 60
        params["vote_count.lte"] = 500

    elif category == "popular_tv":
        # 热门剧集
        endpoint = "/3/discover/tv"
        params["sort_by"] = "popularity.desc"
        params["vote_count.gte"] = 15
        is_tv = True

    elif category == "popular_anime":
        # 热门动画剧集
        endpoint = "/3/discover/tv"
        params["with_genres"] = "16"
        params["sort_by"] = "popularity.desc"
        params["vote_count.gte"] = 10
        is_tv = True

    elif category == "popular_variety":
        # 热门综艺：真人秀 (10764) 或 脱口秀/访谈 (10767)
        endpoint = "/3/discover/tv"
        params["with_genres"] = "10764|10767"
        params["sort_by"] = "popularity.desc"
        is_tv = True

    elif category == "popular_doc":
        # 热门纪录片
        endpoint = "/3/discover/movie"
        params["with_genres"] = "99"
        params["sort_by"] = "popularity.desc"
        params["vote_count.gte"] = 10

    else:
        endpoint = "/3/discover/movie"
        params["sort_by"] = "popularity.desc"

    headers, query_params = _get_headers_and_params(params)
    url = f"{base_url}{endpoint}"

    try:
        async with _get_http_client() as client:
            resp = await client.get(url, headers=headers, params=query_params)
            if resp.status_code != 200:
                err_data = resp.json() if "application/json" in resp.headers.get("Content-Type", "") else {}
                return {
                    "items": [],
                    "page": page,
                    "total_pages": 0,
                    "error": f"TMDB 请求失败: {err_data.get('status_message', resp.text)}",
                }
            data = resp.json()

        results = data.get("results", [])
        items: List[Dict[str, Any]] = []

        for item in results:
            formatted = _format_tmdb_item(item, default_is_tv=is_tv)
            items.append(formatted)

        out = {
            "items": items,
            "page": data.get("page", 1),
            "total_pages": min(data.get("total_pages", 1), 50),
            "error": None,
        }
        _CACHE[cache_key] = (now, out)
        return out
    except Exception as e:
        return {
            "items": [],
            "page": page,
            "total_pages": 0,
            "error": f"网络异常: {str(e)}",
        }


async def search_media(query: str, page: int = 1) -> Dict[str, Any]:
    """
    TMDB 多类型搜索 (电影/电视剧/动漫/纪录片)
    """
    cfg = get_config()
    clean_query = query.strip()
    if not clean_query:
        return {"items": [], "page": 1, "total_pages": 0, "error": "请输入搜索关键词"}

    if not cfg.tmdb_api_key.strip():
        return {
            "items": [],
            "page": 1,
            "total_pages": 0,
            "error": "未配置 TMDB API 密钥，请前往系统配置设置",
        }

    cache_key = f"search:{clean_query}:{page}"
    now = time.time()
    if cache_key in _CACHE:
        ts, data = _CACHE[cache_key]
        if now - ts < CACHE_TTL:
            return data

    base_url = cfg.tmdb_base_url.rstrip("/")
    params: Dict[str, Any] = {
        "query": clean_query,
        "page": page,
        "include_adult": False,
    }
    endpoint = "/3/search/multi"
    headers, query_params = _get_headers_and_params(params)
    url = f"{base_url}{endpoint}"

    try:
        async with _get_http_client() as client:
            resp = await client.get(url, headers=headers, params=query_params)
            if resp.status_code != 200:
                err_data = resp.json() if "application/json" in resp.headers.get("Content-Type", "") else {}
                return {
                    "items": [],
                    "page": page,
                    "total_pages": 0,
                    "error": f"TMDB 搜索失败: {err_data.get('status_message', resp.text)}",
                }
            data = resp.json()

        results = data.get("results", [])
        items: List[Dict[str, Any]] = []
        for item in results:
            if item.get("media_type") == "person":
                continue
            formatted = _format_tmdb_item(item)
            if formatted:
                items.append(formatted)

        out = {
            "items": items,
            "page": data.get("page", 1),
            "total_pages": min(data.get("total_pages", 1), 50),
            "total_results": data.get("total_results", len(items)),
            "error": None,
        }
        _CACHE[cache_key] = (now, out)
        return out
    except Exception as e:
        return {
            "items": [],
            "page": page,
            "total_pages": 0,
            "error": f"网络异常: {str(e)}",
        }
