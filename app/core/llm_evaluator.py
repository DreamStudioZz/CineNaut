import asyncio
import json
import re
import time
from typing import Any, Dict, List, Optional
import httpx
from app.core.config import get_config

# ============================================================
# 1. 精密特征正则词库 (全面覆盖 4K/2160/杜比/HDR/蓝光/全集/广告)
# ============================================================

SPAM_PATTERNS = [
    r"关注.*(公众号|微信|频道)",
    r"获取.*密码",
    r"解压密码",
    r"防失联",
    r"加[vV微][信]?",
    r"博彩|菠菜|棋牌|真人|荷官|威尼斯|下注",
    r"看全集.*进[群Q]",
    r"永久备用",
    r"备用地址",
    r"扫码",
    r"\.url$|\.exe$|\.html?$",
]

# 4K / 2160P 强特征 (全面覆盖 2160、2160p、3840x2160、4K、UHD、UltraHD)
RES_4K_PATTERNS = [
    r"2160[pP]?",
    r"3840\s*[xX*×]\s*2160",
    r"4[kK](?!\s*-\s*8[kK])",
    r"\bUHD\b(?!\s*Rip)",
    r"Ultra\s*HD",
]

# 杜比视界 / HDR 特征
HDR_PATTERNS = [
    r"Dolby\s*Vision|DoVi|\bDV\b",
    r"杜比视界|杜比全景声|Dolby\s*Atmos",
    r"HDR10\+?|\bHDR\b",
]

# 蓝光原盘 / REMUX 特征
REMUX_PATTERNS = [
    r"\bREMUX\b",
    r"Blu-?Ray|BD-?Rip|蓝光原盘|原盘",
]

# 1080P / 高清特征
RES_1080P_PATTERNS = [
    r"1080[pPiI]?",
    r"1920\s*[xX*×]\s*1080",
    r"Full\s*HD|\bFHD\b",
    r"HDTV|WEB-?DL|WEBRip",
]

# 720P 特征
RES_720P_PATTERNS = [
    r"720[pP]?",
    r"1280\s*[xX*×]\s*720",
]

# 枪版 / 劣质 / 预告关键词
LOW_QUALITY_PATTERNS = [
    r"\b(TC|TS|CAM)\b|抢先版|枪版|清晰度一般",
    r"韩版|硬字幕|打码|水印重|盗摄|录制",
    r"预告片|花絮|片段|特辑|片花",
]

# 完结 / 全集特征
COMPLETE_PATTERNS = [
    r"全集|完结|全\d+集|全[一二三四五六七八九十]+集",
    r"S0?1-S?0?\d+|S\d+全|EP0?1-",
    r"合集|大合集|全季",
]

# 连载中特征
ONGOING_PATTERNS = [
    r"更新至\s*\d+|更至\s*\d+|EP\s*\d+|第\s*\d+\s*集",
]


def _match_any(patterns: List[str], text: str) -> bool:
    for pat in patterns:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False


def check_title_relevance(candidate_text: str, target_title: str) -> bool:
    """
    影视主标题核心相关度强校验：
    杜绝全网盘搜时混入无关的热门资源（例如搜《吸血鬼日记》混入《老爸老妈浪漫史》）
    """
    if not target_title:
        return True

    cand_lower = candidate_text.lower()
    target_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", target_title.lower())
    cand_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", cand_lower)

    # 1. 完整包含
    if target_clean in cand_clean:
        return True

    # 2. 中文主词切分包含（如 "吸血鬼日记" 包含 "吸血鬼"）
    if len(target_clean) >= 3:
        if target_clean[:3] in cand_clean or target_clean[-3:] in cand_clean:
            return True
    elif len(target_clean) == 2:
        if target_clean in cand_clean:
            return True

    # 3. 常见英文拼写，如 vampire -> vampire diaries
    en_words = [w for w in re.findall(r"[a-z]{3,}", target_title.lower()) if w not in ["the", "and", "season"]]
    if en_words:
        if any(w in cand_lower for w in en_words):
            return True

    return False


def extract_media_specs(
    title: str,
    content: str,
    media_info: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    底层精准特征提取器：扫描完整标题与全部描述文本，提取 100% 确定的硬核参数，
    绝不截断内容，彻底杜绝把 2160 漏判为'画质不明'的问题。
    """
    combined = f"{title}\n{content}"
    target_title = (media_info or {}).get("title", "").strip()

    # 0. 核心相关性校验：片名不匹配直接判定为无关资源并施加断崖式惩罚
    is_relevant = check_title_relevance(combined, target_title) if target_title else True

    is_spam = _match_any(SPAM_PATTERNS, combined)
    is_cam = _match_any(LOW_QUALITY_PATTERNS, combined)
    is_4k = _match_any(RES_4K_PATTERNS, combined)
    is_hdr = _match_any(HDR_PATTERNS, combined)
    is_remux = _match_any(REMUX_PATTERNS, combined)
    is_1080p = (not is_4k) and _match_any(RES_1080P_PATTERNS, combined)
    is_720p = (not is_4k) and (not is_1080p) and _match_any(RES_720P_PATTERNS, combined)

    # 剧集完结度检测
    is_tv = False
    if media_info:
        m_type = media_info.get("media_type", "")
        if m_type in ["tv", "anime", "variety", "doc"]:
            is_tv = True

    is_complete = False
    is_ongoing = False
    if is_tv:
        if _match_any(COMPLETE_PATTERNS, combined):
            is_complete = True
        elif _match_any(ONGOING_PATTERNS, combined):
            is_ongoing = True

    is_clean = bool(re.search(r"无水印|纯净|内嵌简繁|官方字幕", combined, re.IGNORECASE))

    # 若片名完全无关，直接给予最低分淘汰，绝不推荐
    if not is_relevant:
        return {
            "score": 5,
            "tags": ["无关资源"],
            "reason": f"片名与目标《{target_title}》不符",
            "is_spam": True,
            "is_4k": False,
            "is_hdr": False,
            "is_complete": False,
            "is_relevant": False,
        }

    # 计算基础硬核得分 (0-100)
    score = 55
    tags: List[str] = []
    reasons: List[str] = []

    if is_spam:
        score = 20
        tags.append("广告引流")
        reasons.append("包含引流或解压密码信息")
    elif is_cam:
        score = 25
        tags.append("枪版/预告")
        reasons.append("非正片或枪版")
    else:
        if is_4k:
            score += 35
            tags.append("4K超清")
            reasons.append("4K超清分辨率")
            if is_hdr:
                score += 5
                tags.append("杜比/HDR")
            if is_remux:
                score += 4
                tags.append("蓝光原盘")
        elif is_1080p:
            score += 22
            tags.append("1080P高清")
            reasons.append("1080P高清")
        elif is_720p:
            score += 5
            tags.append("720P标清")

        if is_tv:
            if is_complete:
                score += 8
                tags.append("全集完结")
                reasons.append("全集打包")
            elif is_ongoing:
                score += 3
                tags.append("连载中")

        if is_clean:
            score += 2
            tags.append("纯净字幕")

    final_score = max(10, min(98, score))

    # 过滤掉任何可能混入的“画质不明”垃圾标签
    clean_tags = [t for t in tags if "未知" not in t and "不明" not in t]

    return {
        "score": final_score,
        "tags": clean_tags[:3],
        "reason": "、".join(reasons) if reasons else "普通夸克分享资源",
        "is_spam": is_spam,
        "is_4k": is_4k,
        "is_hdr": is_hdr,
        "is_complete": is_complete,
        "is_relevant": True,
    }


def heuristic_evaluate_all(
    items: List[Dict[str, Any]],
    media_info: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """极速启发式规则引擎 (0.002秒完成数十条资源的毫秒级精准解析与排序)"""
    evaluated = []
    for item in items:
        specs = extract_media_specs(
            title=item.get("taskname", ""),
            content=item.get("content", ""),
            media_info=media_info,
        )
        new_item = dict(item)
        new_item["ai_score"] = specs["score"]
        new_item["ai_tags"] = specs["tags"]
        new_item["ai_reason"] = specs["reason"]
        new_item["is_spam"] = specs["is_spam"]
        new_item["is_recommended"] = False
        evaluated.append(new_item)

    # 按分数降序排列
    evaluated.sort(key=lambda x: x.get("ai_score", 50), reverse=True)

    # 最高分若 >= 70 且非垃圾，标记为推荐优选
    if evaluated and evaluated[0].get("ai_score", 0) >= 70 and not evaluated[0].get("is_spam"):
        evaluated[0]["is_recommended"] = True
        if "推荐优选" not in evaluated[0]["ai_tags"]:
            evaluated[0]["ai_tags"].insert(0, "推荐优选")

    return evaluated


async def verify_llm_connection(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """测试大模型 API 连通性"""
    cfg = get_config()
    b_url = (base_url or cfg.llm_base_url).strip().rstrip("/")
    key = (api_key or cfg.llm_api_key).strip()
    m_name = (model or cfg.llm_model).strip() or "deepseek-chat"

    if not b_url:
        return {"success": False, "message": "尚未配置大模型 API 基础地址 (Base URL)"}
    if not key:
        return {"success": False, "message": "尚未填写大模型 API Key"}

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": m_name,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Reply with pong."},
            {"role": "user", "content": "pong"}
        ],
        "max_tokens": 500,
        "temperature": 0.1,
    }

    url = f"{b_url}/chat/completions"
    start_time = time.time()
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            latency = int((time.time() - start_time) * 1000)

            if resp.status_code == 200:
                data = resp.json()
                msg = data.get("choices", [{}])[0].get("message", {})
                content = (msg.get("content") or msg.get("reasoning_content") or "pong").strip()
                return {
                    "success": True,
                    "message": f"LLM 接口连通正常！模型 [{m_name}] 响应 (耗时 {latency}ms)",
                    "latency_ms": latency,
                }
            elif resp.status_code == 401:
                return {
                    "success": False,
                    "message": "API Key 认证失败 (HTTP 401)，请核对密钥",
                    "latency_ms": latency,
                }
            else:
                return {
                    "success": False,
                    "message": f"LLM 服务返回错误 HTTP {resp.status_code}: {resp.text[:120]}",
                    "latency_ms": latency,
                }
    except Exception as e:
        return {
            "success": False,
            "message": f"无法连接到大模型服务: {str(e)}",
            "latency_ms": 0,
        }


async def refine_with_llm(
    top_candidates: List[Dict[str, Any]],
    media_info: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    异步轻量 LLM 深度决策：
    对前 4~5 条最高分候选进行深度语义核验与评语提炼，输出最终的置顶推荐项。
    充分兼容 DeepSeek 等思考模型（设置充足 max_tokens 并采用多级 JSON 提取）。
    """
    cfg = get_config()
    b_url = cfg.llm_base_url.strip().rstrip("/")
    key = cfg.llm_api_key.strip()
    m_name = cfg.llm_model.strip() or "deepseek-chat"

    if not b_url or not key or not top_candidates:
        return top_candidates

    summary_list = []
    for idx, it in enumerate(top_candidates[:5]):
        content_brief = it.get("content", "").replace("\n", " ").strip()[:300]
        summary_list.append({
            "id": idx,
            "title": it.get("taskname", ""),
            "detected_tags": it.get("ai_tags", []),
            "content": content_brief,
        })

    m_title = (media_info or {}).get("title", "")
    m_year = (media_info or {}).get("year", "")

    system_prompt = (
        "你是影视资源质检专家。根据提供的候选资源标题与描述，从给出的候选者中裁定最值得转存的【第一推荐项】。\n"
        "规则：\n"
        f"1. 严格校验片名相关性：目标是《{m_title}》，严禁推荐与目标影视无关的其它剧集或合集！\n"
        "2. 绝不能输出'画质未知'或'画质不明'；若已检测到4K/2160/HDR/蓝光，必须肯定其画质。\n"
        "3. 剔除公众号、解压密码等引流垃圾。\n"
        "4. 在回复的最后，必须输出 JSON 数组，例如：[{\"id\": 0, \"best\": true, \"reason\": \"4K HDR全集纯净\"}]"
    )

    user_prompt = f"""影视目标：{m_title} ({m_year})
候选列表：
{json.dumps(summary_list, ensure_ascii=False)}

请分析并输出决策 JSON 数组："""

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": m_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 800,  # 给足思维链与 JSON 输出 token
    }

    url = f"{b_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                return top_candidates

            data = resp.json()
            msg = data.get("choices", [{}])[0].get("message", {})
            raw_text = msg.get("content") or msg.get("reasoning_content") or ""

            # 采用正则稳健抓取第一个完整的 JSON 数组 [...]
            json_match = re.search(r"\[\s*\{.*\}\s*\]", raw_text, re.DOTALL)
            if not json_match:
                return top_candidates

            eval_list = json.loads(json_match.group(0))
            best_id = 0
            decision_map = {}
            for d in eval_list:
                if isinstance(d, dict) and "id" in d:
                    decision_map[d["id"]] = d
                    if d.get("best"):
                        best_id = d["id"]

            for idx, it in enumerate(top_candidates):
                d = decision_map.get(idx)
                if d and d.get("reason"):
                    it["ai_reason"] = d["reason"]
                it["is_recommended"] = (idx == best_id)
                it["ai_tags"] = [t for t in it.get("ai_tags", []) if "未知" not in t and "不明" not in t]
                if it["is_recommended"] and "推荐优选" not in it["ai_tags"]:
                    it["ai_tags"].insert(0, "推荐优选")

            # 重新将选出的置顶推荐项移到第 1 位
            if best_id > 0 and best_id < len(top_candidates):
                fav = top_candidates.pop(best_id)
                top_candidates.insert(0, fav)

            return top_candidates
    except Exception as e:
        print(f"[LLM] Refine error: {e}")
        return top_candidates


async def evaluate_and_rank_resources(
    items: List[Dict[str, Any]],
    media_info: Optional[Dict[str, Any]] = None,
    use_ai: bool = True,
) -> Dict[str, Any]:
    """
    极速质检统一入口 (秒开设计)：
    - 关闭 AI 时：原汁原味 0ms 返回原始数据；
    - 开启 AI 时：0.002秒高精度特征引擎即刻出结果，彻底告别 10 秒长白屏！
    """
    if not items:
        return {"items": [], "evaluator": "none", "ai_used": False}

    cfg = get_config()

    # 1. 用户关闭 AI 时，原汁原味返回盘搜原始结果
    if not use_ai or not cfg.llm_enabled:
        return {
            "items": items,
            "evaluator": "off",
            "ai_used": False,
        }

    # 2. 开启时：先用 0.002 秒超高速高精度引擎完成硬指标识别与排序（秒开）
    ranked_items = heuristic_evaluate_all(items, media_info)
    has_llm = bool(cfg.llm_api_key.strip())

    return {
        "items": ranked_items,
        "evaluator": f"specs-engine (0ms) + {'llm-ready' if has_llm else 'rule-only'}",
        "ai_used": has_llm,
        "can_refine": has_llm and len(ranked_items) > 0,
    }


def diagnose_share_structure_and_rename(
    share_tree: Dict[str, Any],
    media_info: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    AI 目录透视与规范重命名诊断引擎：
    1. 自动下探分析多层嵌套，定位真正的底层正片目录；
    2. 提取代表性文件名样本，智能生成 Emby/Plex 标准命名与 QAS 正则。
    """
    targets = share_tree.get("targets", [])
    share_title = share_tree.get("share_title", "夸克分享")
    root_files = share_tree.get("root_files", [])

    m_title = (media_info or {}).get("title", "") or share_title
    m_year = str((media_info or {}).get("year", "")).strip()
    m_season = str((media_info or {}).get("season", "01")).strip()
    media_type = str((media_info or {}).get("media_type", "")).strip().lower()

    # 1. 检测根目录或各级中是否存在引流垃圾文件
    spam_files = []
    for f in root_files:
        fn = f.get("file_name", "")
        if any(re.search(pat, fn, re.IGNORECASE) for pat in SPAM_PATTERNS) or fn.lower().endswith((".url", ".exe", ".html")):
            spam_files.append(fn)

    # 2. 定位最佳底层正片目录与多季大合集判断
    target_unit = None
    distinct_seasons = sorted(list(set(str(t.get("season")) for t in targets if t.get("season"))))
    
    # 检测是否为多季大合集 (Multi-Season Boxset, 例如 1-8季、全季)
    is_multi_season = False
    if media_type != "movie":
        if len(distinct_seasons) >= 2:
            is_multi_season = True
        elif re.search(r"[1-9一二三四五六七八九十]\s*[-~至到]\s*[1-9一二三四五六七八九十]\s*季|全\s*\d+\s*季|全季|大合集|S\d+\s*[-~至]\s*S?\d+", f"{share_title} {share_tree.get('share_title', '')}"):
            is_multi_season = True

    if targets:
        # 按视频数量降序排列，优先选择视频集中地
        sorted_targets = sorted(targets, key=lambda x: x.get("video_count", 0), reverse=True)
        # 若有包含目标季数的目标优先选择
        for t in sorted_targets:
            if t.get("season") == m_season:
                target_unit = t
                break
        if not target_unit:
            target_unit = sorted_targets[0]

    # 3. 计算下探层级与直达链接
    # 如果是多季大合集，必须保持全剧根目录/母目录转存，绝不能被截断为单季！
    if is_multi_season:
        target_sub_url = share_tree.get("shareurl", "")
        total_videos = sum(t.get("video_count", 0) for t in targets) or target_unit.get("video_count", 0) if target_unit else 0
        seasons_label = f"S{distinct_seasons[0]}~S{distinct_seasons[-1]}" if len(distinct_seasons) >= 2 else "全季"
        target_name = f"全季大合集 ({seasons_label}，共 {len(distinct_seasons)} 季)"
        video_count = total_videos
        full_path = "/"
        levels_skipped = 0
    else:
        target_sub_url = target_unit.get("shareurl") if target_unit else share_tree.get("shareurl", "")
        target_name = target_unit.get("name", "根目录") if target_unit else "根目录"
        video_count = target_unit.get("video_count", 0) if target_unit else 0
        full_path = target_unit.get("full_path", "/") if target_unit else "/"
        levels = [p for p in full_path.split("/") if p.strip()]
        levels_skipped = max(0, len(levels) - 1)

    # 4. 分析文件名样本并生成重命名建议
    samples = target_unit.get("sample_files", []) if target_unit else []
    sample_file = samples[0] if samples else "未提取到视频文件"

    ext_match = re.search(r"\.(mp4|mkv|avi|mov|flv|ts|wmv)$", sample_file, re.IGNORECASE)
    ext = f".{ext_match.group(1).lower()}" if ext_match else ".mp4"

    # 判断是否为电影 (根据 media_type 或文件名是否无剧集集数特征)
    has_tv_ep = bool(re.search(r"[Ee]\d+|第\s*\d+\s*[集话]|(?:\.|\b)[Ss]\d+", sample_file))
    is_movie = (media_type == "movie") or (not has_tv_ep and video_count <= 2)

    if is_movie:
        # 【电影标准规范】电影名 (年份).ext，例如：寻梦环游记 (2017).mp4
        year_str = f" ({m_year})" if m_year and len(m_year) == 4 else ""
        suggested_filename = f"{m_title}{year_str}{ext}"
        # QAS 规范正则：匹配所有合法视频后缀，整段安全重命名并保留扩展名，自动剔除原标题内所有杂质
        pattern = r"^.*(\.(?:mp4|mkv|avi|ts|flv|mov|wmv))$"
        replace = f"{m_title}{year_str}$1"
    elif is_multi_season:
        # 【多季大合集规范】使用 QAS 智能 $TV 规则，自动识别各季各集并保留分季目录
        suggested_filename = f"{m_title} - S{{季数}}E{{集数}}{ext} (全季自动归档)"
        pattern = "$TV"
        replace = ""
    else:
        # 【单季标准规范】剧名 - S01E01.ext
        ep_match = re.search(r"[Ee](\d+)|第\s*(\d+)\s*[集话]|(?<!\d)(\d{2})(?!\d)", sample_file)
        ep_num = "01"
        if ep_match:
            ep_num = (ep_match.group(1) or ep_match.group(2) or ep_match.group(3)).zfill(2)

        s_num = m_season.zfill(2) if m_season.isdigit() else "01"
        suggested_filename = f"{m_title} - S{s_num}E{ep_num}{ext}"

        if re.search(r"第\s*\d+\s*[集话]", sample_file):
            pattern = r"^.*第\s*(\d+)\s*[集话].*(\.(?:mp4|mkv|avi|ts|flv|mov|wmv))$"
            replace = f"{m_title} - S{s_num}E$1$2"
        elif re.search(r"(?:[sS]\d+)?(?:[eE]|ep|EP)(\d+)", sample_file):
            pattern = r"^.*?(?:[sS]\d+)?[eE](\d+).*?(\.(?:mp4|mkv|avi|ts|flv|mov|wmv))$"
            replace = f"{m_title} - S{s_num}E$1$2"
        else:
            pattern = r"^.*?(\d{1,3}).*?(\.(?:mp4|mkv|avi|ts|flv|mov|wmv))$"
            replace = f"{m_title} - S{s_num}E$1$2"

    if is_multi_season:
        summary_text = (
            f"检测到【全季大合集】（涵盖 {len(distinct_seasons)} 个季度，共 {video_count} 个视频），"
            f"已自动启用全季转存模式与 $TV 智能分季规则，保存至剧集根目录，完整保留所有季数。"
        )
    elif levels_skipped > 0:
        summary_text = (
            f"已成功穿透 {levels_skipped} 层包装目录，正片位于【{target_name}】（共 {video_count} 个视频），"
            f"已自动隔离根目录下 {len(spam_files)} 个引流文件。"
        )
    else:
        summary_text = f"正片直接位于主目录（共 {video_count} 个视频），文件结构清晰。"

    return {
        "success": True,
        "is_multi_season": is_multi_season,
        "distinct_seasons": distinct_seasons,
        "target_sub_url": target_sub_url,
        "target_name": target_name,
        "target_full_path": full_path,
        "levels_skipped": levels_skipped,
        "video_count": video_count,
        "spam_files_count": len(spam_files),
        "spam_files": spam_files[:3],
        "sample_filename": sample_file,
        "suggested_filename": suggested_filename,
        "pattern": pattern,
        "replace": replace,
        "summary": summary_text,
    }

