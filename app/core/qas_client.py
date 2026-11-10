import asyncio
import json
import re
import time
import urllib.parse
from typing import Any, AsyncGenerator, Dict, List, Optional
import httpx
from app.core.config import get_config

VIDEO_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".flv", ".ts",
    ".wmv", ".iso", ".rmvb", ".m4v", ".webm", ".strm"
}
ARCHIVE_EXTS = {".zip", ".rar", ".7z", ".tar", ".gz"}

# 分享目录树短时缓存：同一分享在 Auto-Pilot 探测与后续透视之间复用，避免重复下探
_TREE_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
TREE_CACHE_TTL = 120  # 秒

# 盘搜结果短时缓存：上游 PanSou/CloudSaver 聚合常需 10~25 秒，重复打开同一影片直接复用
_SEARCH_CACHE: Dict[str, tuple[float, List[Dict[str, Any]]]] = {}
SEARCH_CACHE_TTL = 300  # 秒


def parse_season_number(text: str) -> Optional[str]:
    """从文本或路径中识别季度编号（如 Season 01 -> 01, 第一季 -> 01）"""
    cn_num = {
        "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
        "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
        "十一": 11, "十二": 12
    }
    m = re.search(r"(?:season|s)\s*(\d{1,2})", text, re.I)
    if m:
        return f"{int(m.group(1)):02d}"
    m = re.search(r"第\s*(\d{1,2})\s*季", text)
    if m:
        return f"{int(m.group(1)):02d}"
    m = re.search(r"第\s*([一二三四五六七八九十]+)\s*季", text)
    if m and m.group(1) in cn_num:
        return f"{cn_num[m.group(1)]:02d}"
    if re.search(r"(?:特别篇|番外|sp|ova)", text, re.I):
        return "00"
    return None


def extract_pwd_id(url: str) -> Optional[str]:
    """提取夸克分享的 short id"""
    m = re.search(r"/s/(\w+)", url)
    return m.group(1) if m else None


def _get_http_client() -> httpx.AsyncClient:
    # QAS 服务通常部署在本地或局域网容器内，直连无需代理 (trust_env=False 防止环境变量代理干扰)
    return httpx.AsyncClient(timeout=30.0, follow_redirects=True, trust_env=False)


def _build_url(endpoint: str, params: Optional[Dict[str, Any]] = None) -> str:
    cfg = get_config()
    base_url = cfg.qas_base_url.rstrip("/")
    token = cfg.qas_token.strip()
    p = params.copy() if params else {}
    if token:
        p["token"] = token
    query_str = httpx.QueryParams(p)
    return f"{base_url}{endpoint}?{query_str}" if query_str else f"{base_url}{endpoint}"


async def verify_qas_connection() -> Dict[str, Any]:
    """测试 QAS 连通性及状态"""
    cfg = get_config()
    if not cfg.qas_base_url.strip():
        return {
            "success": False,
            "message": "尚未配置 QAS 服务地址",
            "latency_ms": 0,
        }

    url = _build_url("/data")
    start_time = time.time()
    try:
        async with _get_http_client() as client:
            resp = await client.get(url)
            latency = int((time.time() - start_time) * 1000)

            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    qas_data = data.get("data", {})
                    task_count = len(qas_data.get("tasklist", []))
                    cookies = qas_data.get("cookie", [])
                    has_cookie = bool(cookies and len(cookies) > 0 and len(cookies[0].strip()) > 10)
                    return {
                        "success": True,
                        "message": f"QAS 服务连通正常！延迟 {latency}ms",
                        "latency_ms": latency,
                        "task_count": task_count,
                        "has_cookie": has_cookie,
                        "crontab": qas_data.get("crontab", ""),
                    }
                else:
                    return {
                        "success": False,
                        "message": data.get("message", "QAS 返回鉴权失败，请检查 Token"),
                        "latency_ms": latency,
                    }
            elif resp.status_code == 401 or resp.status_code == 403:
                return {
                    "success": False,
                    "message": "QAS Token 无效或未授权",
                    "latency_ms": latency,
                }
            else:
                return {
                    "success": False,
                    "message": f"QAS 响应异常 HTTP {resp.status_code}",
                    "latency_ms": latency,
                }
    except Exception as e:
        return {
            "success": False,
            "message": f"无法连接 QAS 服务: {str(e)}",
            "latency_ms": 0,
        }


async def _search_once(query: str, deep: bool, timeout: float) -> List[Dict[str, Any]]:
    url = _build_url("/task_suggestions", {"q": query, "d": "1" if deep else "0"})
    async with _get_http_client() as client:
        # wait_for 强制墙钟超时：上游偶发慢速吐流，仅靠 httpx 的 read timeout 会拖到 50s+
        resp = await asyncio.wait_for(client.get(url, timeout=timeout), timeout=timeout)
        if resp.status_code != 200:
            return []
        res = resp.json()
        if res.get("success"):
            return res.get("data", [])
        return []


async def search_resources(query: str, deep: bool = False) -> List[Dict[str, Any]]:
    """调用 QAS 聚合搜索（PanSou / CloudSaver）检索夸克网盘分享资源"""
    cache_key = f"{query}|{int(deep)}"
    cached = _SEARCH_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < SEARCH_CACHE_TTL:
        return cached[1]
    stale = cached[1] if cached else None

    for _ in range(2):
        started = time.time()
        try:
            results = await _search_once(query, deep, timeout=30.0)
        except asyncio.TimeoutError:
            results = []
        except Exception as e:
            print(f"[QAS] search_resources error: {e}")
            results = []

        if results:
            _SEARCH_CACHE[cache_key] = (time.time(), results)
            return results

        # 慢失败（含超时）不重试，避免把 30s 翻倍；只有快速失败才补一次
        if time.time() - started > 10.0:
            break

    # 上游抖动时回退到上一次成功结果，避免用户直接拿不到任何候选
    return stale or []


async def get_share_detail(
    shareurl: str,
    task: Optional[Dict[str, Any]] = None,
    timeout: float = 20.0,
) -> Dict[str, Any]:
    """解析夸克分享链接文件信息并模拟重命名"""
    url = _build_url("/get_share_detail")
    payload: Dict[str, Any] = {"shareurl": shareurl}
    if task:
        task_copy = dict(task)
        pattern = task_copy.get("pattern", ".*")
        if pattern == "$TV_MAGIC":
            pattern = "$TV"
        # 若是 $TV 等魔法变量，自动展开其实际的 pattern 与 replace 规则，方便 QAS 模拟重命名
        if pattern and pattern.startswith("$"):
            magic = await get_magic_regex()
            if pattern in magic:
                rule = magic[pattern]
                task_copy["pattern"] = rule.get("pattern", ".*")
                if not task_copy.get("replace"):
                    task_copy["replace"] = rule.get("replace", "")
            else:
                task_copy["pattern"] = ".*"
        else:
            task_copy["pattern"] = pattern or ".*"
        payload["task"] = task_copy

    try:
        async with _get_http_client() as client:
            resp = await client.post(url, json=payload, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()
            return {"success": False, "message": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


async def explore_share_tree(
    shareurl: str,
    max_depth: int = 4,
    max_scan_folders: int = 20,
    request_timeout: float = 20.0,
) -> Dict[str, Any]:
    """
    深度递归探测夸克分享链接的目录树结构：
    自动下探多层包装文件夹，识别多季目录与深层叶子视频目录，
    生成精确带 #/list/share/{fid} 的可执行转存单元列表。

    max_scan_folders / request_timeout 用于低延迟场景下限制扫描目录数与单请求超时；
    结果按 (url, 深度, 目录数, 超时) 缓存 2 分钟。
    """
    cache_key = f"{shareurl}|{max_depth}|{max_scan_folders}|{request_timeout}"
    cached = _TREE_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < TREE_CACHE_TTL:
        return cached[1]

    pwd_id = extract_pwd_id(shareurl)
    if not pwd_id:
        return {"success": False, "message": "无效的夸克分享链接", "targets": []}

    # 1. 获取根目录结构
    root_res = await get_share_detail(shareurl, timeout=request_timeout)
    if not root_res.get("success"):
        return {"success": False, "message": root_res.get("message") or "获取分享详情失败", "targets": []}

    root_data = root_res.get("data", {})
    root_list = root_data.get("list", [])
    share_info = root_data.get("share", {})
    share_title = share_info.get("title", "夸克分享")

    targets: List[Dict[str, Any]] = []

    # 检查根目录下是否直接有视频或压缩包
    root_videos = [
        f for f in root_list
        if not f.get("dir") and any(f.get("file_name", "").lower().endswith(ext) for ext in VIDEO_EXTS | ARCHIVE_EXTS)
    ]
    root_dirs = [f for f in root_list if f.get("dir")]

    if root_videos:
        targets.append({
            "name": share_title or "根目录/全集",
            "fid": "0",
            "shareurl": shareurl,
            "season": parse_season_number(share_title) or "01",
            "video_count": len(root_videos),
            "sample_files": [f["file_name"] for f in root_videos[:3]],
            "full_path": "/",
        })

    # BFS 队列: (folder_name, folder_fid, full_path, depth)
    queue = [(d["file_name"], d["fid"], f"/{d['file_name']}", 1) for d in root_dirs]
    visited_fids = set()

    # 最大扫描目录数，防止巨型死循环
    max_scan_folders = max(1, max_scan_folders)
    scanned_count = 0

    while queue and scanned_count < max_scan_folders:
        folder_name, folder_fid, full_path, depth = queue.pop(0)
        if folder_fid in visited_fids:
            continue
        visited_fids.add(folder_fid)
        scanned_count += 1

        # 构造直达该子目录的精确 shareurl
        quoted_name = urllib.parse.quote(folder_name)
        sub_shareurl = f"https://pan.quark.cn/s/{pwd_id}#/list/share/{folder_fid}-{quoted_name}"

        sub_res = await get_share_detail(sub_shareurl, timeout=request_timeout)
        if not sub_res.get("success"):
            continue

        sub_files = sub_res.get("data", {}).get("list", [])
        videos = [
            f for f in sub_files
            if not f.get("dir") and any(f.get("file_name", "").lower().endswith(ext) for ext in VIDEO_EXTS | ARCHIVE_EXTS)
        ]
        sub_dirs = [f for f in sub_files if f.get("dir")]

        if videos:
            season_num = parse_season_number(folder_name) or parse_season_number(full_path)
            targets.append({
                "name": folder_name,
                "fid": folder_fid,
                "shareurl": sub_shareurl,
                "season": season_num,
                "video_count": len(videos),
                "sample_files": [f["file_name"] for f in videos[:3]],
                "full_path": full_path,
            })

        # 若还有下层目录且未超限，继续推进队列
        if sub_dirs and depth < max_depth:
            for sd in sub_dirs:
                queue.append((sd["file_name"], sd["fid"], f"{full_path}/{sd['file_name']}", depth + 1))

    # 按季度编号和层级自然排序
    def sort_key(t):
        s = t.get("season")
        if s and s.isdigit():
            return int(s)
        return 999

    targets.sort(key=sort_key)

    result = {
        "success": True,
        "share_title": share_title,
        "is_multi_target": len(targets) > 1,
        "targets_count": len(targets),
        "targets": targets,
        "root_files": root_list,
    }
    _TREE_CACHE[cache_key] = (time.time(), result)
    return result


async def get_magic_regex() -> Dict[str, Any]:
    """获取 QAS 中配置的全部魔法变量与正则规则"""
    url = _build_url("/data")
    try:
        async with _get_http_client() as client:
            resp = await client.get(url, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    return data.get("data", {}).get("magic_regex", {})
            return {}
    except Exception as e:
        print(f"[QAS] get_magic_regex error: {e}")
        return {}


def _normalize_task(t: Dict[str, Any]) -> Dict[str, Any]:
    """标准化转存任务参数，纠正魔法变量与默认子目录透传"""
    task = dict(t)
    pattern = task.get("pattern", ".*")
    # 兼容历史传入的 $TV_MAGIC，自动纠正为 QAS 实例真实的 $TV
    if pattern == "$TV_MAGIC":
        pattern = "$TV"
    task["pattern"] = pattern or ".*"

    # 核心安全防御：检测 pattern 与 replace 的捕获组引用匹配
    raw_replace = str(task.get("replace", "") or "")
    if raw_replace:
        # 将前端 JS 习惯的 $1, $2 转换为 Python 正则替换习惯的 \1, \2
        clean_replace = re.sub(r"\$(\d+)", r"\\\1", raw_replace)

        # 查找 replace 引用了哪些捕获组序号（例如 \1, \2）
        refs = [int(m) for m in re.findall(r"\\(\d+)", clean_replace)]
        max_ref = max(refs) if refs else 0

        if max_ref > 0:
            # 统计 pattern 中实际有多少个合法的捕获组
            try:
                compiled = re.compile(task["pattern"])
                num_groups = compiled.groups
            except Exception:
                num_groups = 0

            if num_groups < max_ref:
                # 出现捕获组缺失错配！例如 pattern=".*" 没有任何捕获组，却引用了 \1
                # 智能纠正：如果 pattern 是 ".*" 且引用了 \1，说明意图是整段重命名并保留视频后缀
                if task["pattern"] == ".*" and max_ref == 1:
                    task["pattern"] = r"^.*(\.(?:mp4|mkv|avi|ts|flv|mov|wmv|m4v|rmvb|webm))$"
                    task["replace"] = clean_replace
                else:
                    # 无法安全补全，清空非法引用，保证 QAS 绝不崩溃
                    task["replace"] = ""
            else:
                task["replace"] = clean_replace
        else:
            task["replace"] = clean_replace
    else:
        task["replace"] = ""

    # 默认透传多层子目录
    if not task.get("update_subdir"):
        task["update_subdir"] = ".*"

    # 兜底确保 savepath 存在，杜绝 QAS 报 KeyError: 'savepath'
    if not task.get("savepath"):
        task["savepath"] = "/"

    if "ignore_extension" not in task:
        task["ignore_extension"] = False

    if "runweek" not in task:
        task["runweek"] = [1, 2, 3, 4, 5, 6, 7]

    return task


async def add_task(task_data: Dict[str, Any]) -> Dict[str, Any]:
    """向 QAS 添加定时转存追更任务"""
    url = _build_url("/api/add_task")
    normalized = _normalize_task(task_data)
    try:
        async with _get_http_client() as client:
            resp = await client.post(url, json=normalized, timeout=15.0)
            data = resp.json() if resp.status_code in [200, 400, 401] else {}
            if resp.status_code == 200 and data.get("success"):
                return {"success": True, "message": "转存任务已成功加入 QAS 调度队列", "data": data.get("data")}
            return {
                "success": False,
                "message": data.get("message") or f"添加任务失败 HTTP {resp.status_code}",
            }
    except Exception as e:
        return {"success": False, "message": f"添加任务异常: {str(e)}"}


async def run_task_stream(tasklist: Optional[List[Dict[str, Any]]] = None) -> AsyncGenerator[str, None]:
    """即时触发转存任务，通过 SSE 产生流式执行日志"""
    url = _build_url("/run_script_now")

    # 核心增强：如果 tasklist 中的任务缺少 savepath 或 shareurl，主动从 QAS 现有任务列表 (/data) 中拉取并补齐！
    raw_tasks = tasklist or []
    needs_enrich = any(not (t.get("savepath") and t.get("shareurl")) for t in raw_tasks)

    enriched_tasks = []
    if needs_enrich:
        try:
            full_data = await get_tasks()
            existing_tasks = {
                t.get("taskname"): t
                for t in full_data.get("tasklist", [])
                if t.get("taskname")
            }
        except Exception as err:
            print(f"[QAS] Failed to load existing tasks for enrich: {err}")
            existing_tasks = {}

        for t in raw_tasks:
            t_name = t.get("taskname")
            if (not t.get("savepath") or not t.get("shareurl")) and t_name in existing_tasks:
                merged = dict(existing_tasks[t_name])
                merged.update(t)
                enriched_tasks.append(merged)
            else:
                enriched_tasks.append(t)
    else:
        enriched_tasks = raw_tasks

    normalized_tasks = [_normalize_task(t) for t in enriched_tasks]
    payload = {"tasklist": normalized_tasks}

    client = _get_http_client()
    try:
        req = client.build_request("POST", url, json=payload, timeout=600.0)
        resp = await client.send(req, stream=True)

        if resp.status_code != 200:
            yield f"data: [ERROR] QAS 响应异常 HTTP {resp.status_code}\n\n"
            return

        async for line in resp.aiter_lines():
            if line:
                yield f"{line}\n\n"
    except Exception as e:
        yield f"data: [ERROR] 转存触发执行异常: {str(e)}\n\n"
    finally:
        await client.aclose()


async def get_tasks() -> Dict[str, Any]:
    """获取 QAS 现有的全部任务列表与配置"""
    url = _build_url("/data")
    try:
        async with _get_http_client() as client:
            resp = await client.get(url, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    return {
                        "success": True,
                        "tasklist": data.get("data", {}).get("tasklist", []),
                        "crontab": data.get("data", {}).get("crontab", ""),
                    }
            return {"success": False, "message": "获取任务列表失败", "tasklist": []}
    except Exception as e:
        return {"success": False, "message": str(e), "tasklist": []}


async def batch_delete_tasks(tasknames: List[str]) -> Dict[str, Any]:
    """批量从 QAS 中删除指定的多个任务"""
    if not tasknames:
        return {"success": False, "message": "未指定要删除的任务"}
    to_delete_set = set(tasknames)
    url_data = _build_url("/data")
    url_update = _build_url("/update")
    try:
        async with _get_http_client() as client:
            resp = await client.get(url_data, timeout=15.0)
            if resp.status_code != 200:
                return {"success": False, "message": "无法获取当前任务列表"}
            data = resp.json()
            if not data.get("success"):
                return {"success": False, "message": data.get("message", "未授权")}

            tasklist = data.get("data", {}).get("tasklist", [])
            new_tasklist = [t for t in tasklist if t.get("taskname") not in to_delete_set]
            deleted_count = len(tasklist) - len(new_tasklist)
            if deleted_count == 0:
                return {"success": False, "message": "未在 QAS 中找到指定任务"}

            up_resp = await client.post(url_update, json={"tasklist": new_tasklist}, timeout=15.0)
            if up_resp.status_code == 200 and up_resp.json().get("success"):
                return {
                    "success": True,
                    "deleted_count": deleted_count,
                    "message": f"已成功移除 {deleted_count} 个转存任务",
                }
            return {"success": False, "message": "更新任务列表失败"}
    except Exception as e:
        return {"success": False, "message": str(e)}


async def delete_task(taskname: str) -> Dict[str, Any]:
    """从 QAS 中删除指定任务"""
    return await batch_delete_tasks([taskname])
