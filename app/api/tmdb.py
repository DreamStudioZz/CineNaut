from fastapi import APIRouter, Query, Response
from fastapi.responses import StreamingResponse
import httpx
from app.core.config import get_config
from app.core.tmdb_client import discover_media, search_media, verify_tmdb_connection

router = APIRouter(prefix="/api/tmdb", tags=["tmdb"])


@router.get("/discover")
async def get_discover_list(
    category: str = Query("popular_movie", description="分类标识"),
    region: str = Query("all", description="地区语言过滤"),
    page: int = Query(1, ge=1, le=50, description="页码"),
):
    """获取影视发现列表"""
    return await discover_media(category=category, region=region, page=page)


@router.get("/search")
async def search_media_list(
    query: str = Query(..., min_length=1, description="搜索关键词"),
    page: int = Query(1, ge=1, le=50, description="页码"),
):
    """搜索全网 TMDB 影视资源 (电影/电视剧/动漫/纪录片)"""
    return await search_media(query=query, page=page)


@router.post("/verify")
async def test_connection():
    """测试 TMDB 连通性与 API 密钥有效性"""
    return await verify_tmdb_connection()


@router.get("/image")
async def proxy_image(
    path: str = Query(..., description="TMDB 图片相对路径，如 /abc.jpg"),
    size: str = Query(default="w500", description="TMDB 图片尺寸规格，如 w500, w780, original")
):
    """
    TMDB 图片代理转发 (支持海报与横幅背景大图)
    解决国内直连 image.tmdb.org 被墙/丢包导致海报破损问题
    """
    cfg = get_config()
    clean_path = path.lstrip("/")
    img_base = cfg.tmdb_image_base_url.rstrip("/")
    valid_sizes = {"w200", "w300", "w400", "w500", "w780", "w1280", "original"}
    actual_size = size if size in valid_sizes else "w500"
    url = f"{img_base}/t/p/{actual_size}/{clean_path}"

    client_kwargs = {"timeout": 20.0, "follow_redirects": True}
    if cfg.proxy and cfg.proxy.strip():
        client_kwargs["proxy"] = cfg.proxy.strip()

    try:
        client = httpx.AsyncClient(**client_kwargs)
        req = client.build_request("GET", url)
        resp = await client.send(req, stream=True)

        if resp.status_code != 200:
            await resp.aclose()
            await client.aclose()
            # 返回 404 或默认占位
            return Response(status_code=404, content=b"Image not found")

        async def stream_content():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        headers = {
            "Content-Type": resp.headers.get("Content-Type", "image/jpeg"),
            "Cache-Control": "public, max-age=86400",  # 浏览器缓存 1 天
        }
        return StreamingResponse(stream_content(), status_code=200, headers=headers)
    except Exception as e:
        return Response(status_code=502, content=f"Proxy error: {str(e)}".encode())
