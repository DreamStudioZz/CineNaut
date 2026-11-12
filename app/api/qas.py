import asyncio
import json
import re
import time
from typing import Any, AsyncGenerator, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from app.core.auth import require_admin
from app.core.config import get_config
from app.core.llm_evaluator import (
    diagnose_share_structure_and_rename,
    evaluate_and_rank_resources,
    refine_with_llm,
)
from app.core.qas_client import (
    add_task,
    batch_delete_tasks,
    delete_task,
    explore_share_tree,
    get_magic_regex,
    get_share_detail,
    get_tasks,
    run_task_stream,
    search_resources,
    verify_qas_connection,
)

router = APIRouter(prefix="/api/qas", tags=["qas"])


class TaskPayload(BaseModel):
    taskname: str = Field(..., description="任务名称")
    shareurl: str = Field(..., description="夸克分享链接")
    savepath: str = Field(..., description="网盘保存路径")
    pattern: Optional[str] = Field(default=".*", description="匹配正则或魔法变量")
    replace: Optional[str] = Field(default="", description="替换模板")
    update_subdir: Optional[str] = Field(default=".*", description="子目录过滤透传")
    ignore_extension: Optional[bool] = Field(default=False, description="忽略后缀重命名")
    runweek: Optional[List[int]] = Field(default=[1, 2, 3, 4, 5, 6, 7], description="运行周期")


class BatchTasksPayload(BaseModel):
    tasks: List[TaskPayload] = Field(..., description="批量转存任务列表")


class BatchDeletePayload(BaseModel):
    tasknames: List[str] = Field(..., description="要删除的任务名称列表")


class ExploreSharePayload(BaseModel):
    shareurl: str = Field(..., description="夸克分享链接")
    max_depth: Optional[int] = Field(default=4, ge=1, le=6, description="最大递归深度")
    media_info: Optional[Dict[str, Any]] = Field(default=None, description="影视元数据")


@router.post("/explore-share-ai")
async def explore_share_with_ai(payload: ExploreSharePayload):
    """
    递归深度探测夸克分享链接目录树，并由 AI 给出结构透视、穿透层级与规范重命名建议
    """
    try:
        tree_res = await asyncio.wait_for(
            explore_share_tree(
                shareurl=payload.shareurl,
                max_depth=payload.max_depth or 4,
                max_scan_folders=8,
                request_timeout=5.0,
            ),
            timeout=9.0,
        )
    except asyncio.TimeoutError:
        return {
            "success": False,
            "message": "分享目录探测超时（9s），请稍后重试或直接在手动模式粘贴链接。",
            "targets": [],
        }
    if not tree_res.get("success"):
        return tree_res

    diagnosis = diagnose_share_structure_and_rename(
        share_tree=tree_res,
        media_info=payload.media_info,
    )
    return {
        "success": True,
        "tree": tree_res,
        "diagnosis": diagnosis,
    }



class ResolvePathPayload(BaseModel):
    media_type: str = Field(..., description="媒体类型: movie, tv, anime, variety, doc")
    title: str = Field(..., description="片名/剧名")
    year: Optional[str] = Field(default="", description="年份")
    season: Optional[str] = Field(default="01", description="季数编号 (如 01)")
    resolution: Optional[str] = Field(default="4K", description="分辨率 (如 4K/1080P)")
    whole_folder: Optional[bool] = Field(default=True, description="是否整剧/整套转存模式")


def _safe_path_name(value: str, fallback: str = "未命名") -> str:
    """清洗路径变量中的分隔符与非法字符，避免生成多余目录或路径穿越。"""
    cleaned = re.sub(r'[\\/:*?"<>|{}\x00-\x1f]+', "_", str(value or "")).strip()
    cleaned = cleaned.strip(". ")
    return cleaned or fallback


def calculate_save_path(
    media_type: str,
    title: str,
    year: str = "",
    season: str = "01",
    resolution: str = "4K",
    whole_folder: bool = True,
) -> Dict[str, str]:
    cfg = get_config()
    m_type = (media_type or "movie").lower()

    # 防御：分辨率变量只接受干净的值，避免把“推荐优选”等标签写进路径
    resolution = (resolution or "4K").strip()
    if not resolution or "推荐" in resolution or "优选" in resolution:
        resolution = "4K"

    if m_type == "movie":
        tpl = cfg.path_movie
    elif m_type == "anime":
        tpl = cfg.path_anime
    elif m_type == "variety":
        tpl = cfg.path_variety
    elif m_type == "doc":
        tpl = cfg.path_doc
    else:
        tpl = cfg.path_tv

    vars_dict = {
        "片名": _safe_path_name(title),
        "剧名": _safe_path_name(title),
        "年份": _safe_path_name(year or "2024", "2024"),
        "季数": _safe_path_name(season or "01", "01"),
        "分辨率": _safe_path_name(resolution or "4K", "4K"),
    }

    resolved = tpl
    for k, v in vars_dict.items():
        resolved = resolved.replace(f"{{{k}}}", v)

    if not resolved.startswith("/"):
        resolved = "/" + resolved

    series_root = resolved
    if m_type != "movie":
        parts = [p for p in resolved.split("/") if p]
        if parts and ("- S" in parts[-1] or "- s" in parts[-1] or "Season" in parts[-1] or "season" in parts[-1]):
            series_root = "/" + "/".join(parts[:-1])
            if whole_folder:
                resolved = series_root

    return {
        "resolved_path": resolved,
        "series_root": series_root,
        "template_used": tpl,
    }


def _slim_candidates(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """精简候选列表，供前端手动模式复用，避免重复盘搜"""
    return [
        {
            "taskname": it.get("taskname", ""),
            "shareurl": it.get("shareurl", ""),
            "datetime": it.get("datetime", ""),
            "ai_score": it.get("ai_score", 0),
            "ai_tags": it.get("ai_tags", []),
            "ai_reason": it.get("ai_reason", ""),
            "is_recommended": it.get("is_recommended", False),
            "is_spam": it.get("is_spam", False),
        }
        for it in items
    ]


def _pick_resolution(candidate: Dict[str, Any]) -> str:
    """从标签与标题中提取干净的分辨率，避免把“推荐优选”等标签写进 {分辨率}"""
    hay = " ".join(candidate.get("ai_tags") or [])
    hay += " " + str(candidate.get("taskname") or "")
    hay += " " + str(candidate.get("content") or "")
    hay = hay.upper()
    if "4K" in hay or "2160" in hay or "UHD" in hay:
        return "4K"
    if "1080" in hay:
        return "1080P"
    if "720" in hay:
        return "720P"
    if "480" in hay:
        return "480P"
    return "4K"


def _build_pilot_decision(
    m_title: str,
    m_year: str,
    m_type: str,
    m_season: str,
    candidate: Dict[str, Any],
    diagnosis: Optional[Dict[str, Any]],
    ranked_items: List[Dict[str, Any]],
    provisional: bool = False,
    verified: bool = False,
) -> Dict[str, Any]:
    """统一构建 Auto-Pilot 决策包（初判与最终共用）"""
    is_boxset = bool(diagnosis and diagnosis.get("is_multi_season"))
    tags = candidate.get("ai_tags") or []
    path_calc = calculate_save_path(
        media_type=m_type,
        title=m_title,
        year=m_year,
        season=m_season,
        resolution=_pick_resolution(candidate),
        whole_folder=True if (is_boxset or m_type != "movie") else False,
    )
    final_shareurl = (diagnosis.get("target_sub_url") if diagnosis else None) or candidate.get("shareurl", "")
    final_pattern = (diagnosis.get("pattern") if diagnosis else None) or ".*"
    final_replace = (diagnosis.get("replace") if diagnosis else None) or ""
    final_savepath = path_calc.get("series_root" if is_boxset else "resolved_path", f"/{m_title}")
    task_name = f"{m_title} ({m_year})" if m_year and len(m_year) == 4 else m_title

    if provisional:
        summary = "初步决策已生成，正在后台并发校验分享目录…"
    elif diagnosis:
        summary = diagnosis.get("summary", "")
    elif not verified:
        summary = "已锁定优选资源（目录校验未完成，可直接转存或手动透视）"
    else:
        summary = "已匹配最优夸克网盘资源"

    return {
        "success": True,
        "provisional": provisional,
        "verified": verified,
        "taskname": task_name,
        "savepath": final_savepath,
        "shareurl": final_shareurl,
        "original_shareurl": candidate.get("shareurl", ""),
        "pattern": final_pattern,
        "replace": final_replace,
        "update_subdir": ".*",
        "selected_resource": {
            "title": candidate.get("taskname", ""),
            "score": candidate.get("ai_score", 80),
            "tags": tags,
            "reason": candidate.get("ai_reason", ""),
            "is_spam": candidate.get("is_spam", False),
        },
        "diagnosis": diagnosis,
        "summary": summary,
        "total_candidates": len(ranked_items),
        "candidates": _slim_candidates(ranked_items),
    }


class AutoPilotPayload(BaseModel):
    title: str = Field(..., description="影视标题")
    year: Optional[str] = Field(default="", description="影视年份")
    media_type: Optional[str] = Field(default="movie", description="媒体类型: movie, tv, anime, variety, doc")
    season: Optional[str] = Field(default="01", description="季数编号")
    deep: Optional[bool] = Field(default=False, description="是否启用深度搜索")


@router.post("/auto-pilot")
async def auto_pilot_workflow(payload: AutoPilotPayload):
    """
    一键智能托管转存 (Auto-Pilot Pipeline):
    1. 自动聚合盘搜全网资源
    2. 毫秒级启发式质检 + LLM 语义甄别，评选出最高分 4K/纯净候选
    3. 自愈探查 (按优先级验证分享树可用性，失效自动回退次优)
    4. 穿透套娃嵌套层级，直达底层正片目录
    5. 一键生成 Emby/Plex 标准命名与规范保存路径
    """
    m_title = payload.title.strip()
    m_year = (payload.year or "").strip()
    m_type = (payload.media_type or "movie").strip().lower()
    m_season = (payload.season or "01").strip()

    if not get_config().llm_enabled:
        return {"success": False, "message": "Auto-Pilot 需要先启用 AI 智能质检。"}

    media_info = {
        "title": m_title,
        "year": m_year,
        "media_type": m_type,
        "season": m_season,
    }

    # 1. 聚合盘搜
    raw_results = await search_resources(query=m_title, deep=payload.deep or False)
    if not raw_results:
        # 若带年份没搜到，尝试仅搜纯标题
        if m_year and m_year in m_title:
            cleaned_title = m_title.replace(m_year, "").strip()
            raw_results = await search_resources(query=cleaned_title, deep=payload.deep or False)

    if not raw_results:
        return {
            "success": False,
            "message": f"全网未检索到与《{m_title}》相关的夸克分享链接，建议勾选深度搜索或更换关键词。",
            "media_info": media_info,
        }

    # 2. 启发式质检与排序
    ranked_data = await evaluate_and_rank_resources(
        items=raw_results,
        media_info=media_info,
        use_ai=True,
    )
    ranked_items = ranked_data.get("items", [])

    # 若可精审，尝试对前 4 条进行 LLM 深度推荐
    if ranked_data.get("can_refine") and len(ranked_items) > 1:
        try:
            refined = await refine_with_llm(top_candidates=ranked_items[:4], media_info=media_info)
            if refined:
                ranked_items = refined + ranked_items[4:]
        except Exception as e:
            print(f"[AutoPilot] Refine fallback: {e}")

    # 3. 自愈探测：按评分依次探测前 3 条候选的分享树有效性
    chosen_candidate = None
    tree_res = None
    diagnosis = None
    fallback_attempts = 0
    probe_any_success = False

    for idx, cand in enumerate(ranked_items[:3]):
        if cand.get("is_spam") and idx > 0:
            continue
        shareurl = cand.get("shareurl", "")
        if not shareurl:
            continue

        probe_tree = await explore_share_tree(shareurl=shareurl, max_depth=4)
        if probe_tree.get("success") and probe_tree.get("targets"):
            probe_any_success = True
            diag = diagnose_share_structure_and_rename(
                share_tree=probe_tree,
                media_info=media_info,
            )
            if diag.get("video_count", 0) > 0:
                chosen_candidate = cand
                tree_res = probe_tree
                diagnosis = diag
                fallback_attempts = idx
                break

    # 若前 3 条都探测失败，回退使用首条候选；若探测成功但只有压缩包，则明确拒绝
    if not chosen_candidate and ranked_items:
        if probe_any_success:
            return {
                "success": False,
                "message": "检索到的资源为空壳包或仅包含压缩包（未发现有效视频文件），建议切换手动模式或更换关键词。",
                "media_info": media_info,
            }
        chosen_candidate = ranked_items[0]

    if not chosen_candidate:
        return {
            "success": False,
            "message": "未能定位到可用的夸克分享链接或该资源已被分享者取消。",
            "media_info": media_info,
        }

    # 4. 计算保存路径
    is_boxset = bool(diagnosis and diagnosis.get("is_multi_season"))
    path_calc = calculate_save_path(
        media_type=m_type,
        title=m_title,
        year=m_year,
        season=m_season,
        resolution=_pick_resolution(chosen_candidate),
        whole_folder=True if (is_boxset or m_type != "movie") else False,
    )

    final_shareurl = (diagnosis.get("target_sub_url") if diagnosis else None) or chosen_candidate.get("shareurl", "")
    final_pattern = (diagnosis.get("pattern") if diagnosis else None) or ".*"
    final_replace = (diagnosis.get("replace") if diagnosis else None) or ""
    final_savepath = path_calc.get("series_root" if is_boxset else "resolved_path", f"/{m_title}")
    task_name = f"{m_title} ({m_year})" if m_year and len(m_year) == 4 else m_title

    # 汇总智能决策描述
    summary_parts = []
    if chosen_candidate.get("ai_tags"):
        summary_parts.append("、".join(chosen_candidate["ai_tags"][:3]))
    if diagnosis and diagnosis.get("levels_skipped", 0) > 0:
        summary_parts.append(f"穿透 {diagnosis['levels_skipped']} 层嵌套目录")
    if diagnosis and diagnosis.get("video_count", 0) > 0:
        summary_parts.append(f"正片共 {diagnosis['video_count']} 个视频")
    if fallback_attempts > 0:
        summary_parts.append(f"第 1 顺位异常已自动切换至第 {fallback_attempts + 1} 优选源")

    summary_text = "；".join(summary_parts) if summary_parts else "已匹配最优夸克网盘资源"

    return {
        "success": True,
        "taskname": task_name,
        "savepath": final_savepath,
        "shareurl": final_shareurl,
        "original_shareurl": chosen_candidate.get("shareurl", ""),
        "pattern": final_pattern,
        "replace": final_replace,
        "update_subdir": ".*",
        "selected_resource": {
            "title": chosen_candidate.get("taskname", ""),
            "score": chosen_candidate.get("ai_score", 80),
            "tags": chosen_candidate.get("ai_tags", []),
            "reason": chosen_candidate.get("ai_reason", ""),
            "is_spam": chosen_candidate.get("is_spam", False),
        },
        "diagnosis": diagnosis,
        "fallback_recovered": fallback_attempts > 0,
        "fallback_from_idx": fallback_attempts,
        "summary": summary_text,
        "total_candidates": len(ranked_items),
    }


async def auto_pilot_stream_generator(payload: AutoPilotPayload) -> AsyncGenerator[str, None]:
    """
    Auto-Pilot 低延迟 SSE 生成器：
    1. 盘搜 + 启发式评分（毫秒级）后立即推送【初判决策】，前端可马上交互；
    2. 后台并发探测 Top 3 候选分享树，校验正片后推送【最终决策】修正初判。
    """
    start_time = time.time()
    m_title = payload.title.strip()
    m_year = (payload.year or "").strip()
    m_type = (payload.media_type or "movie").strip().lower()
    m_season = (payload.season or "01").strip()
    media_info = {"title": m_title, "year": m_year, "media_type": m_type, "season": m_season}

    def emit(data_dict: Dict[str, Any]) -> str:
        data_dict["elapsed"] = round(time.time() - start_time, 2)
        return f"data: {json.dumps(data_dict, ensure_ascii=False)}\n\n"

    if not get_config().llm_enabled:
        yield emit({"type": "error", "message": "Auto-Pilot 需要先启用 AI 智能质检。"})
        yield "data: [DONE]\n\n"
        return

    # Step 1: 盘搜检索
    yield emit({"type": "bus", "step": 1, "status": "active", "sub": "全网并发检索中..."})
    yield emit({
        "type": "node",
        "node_type": "thought",
        "title": "Thought [分析任务目标]",
        "content": f"收到用户转存指令，目标影视: 《{m_title}》{f' ({m_year})' if m_year else ''} [{m_type.upper()}]。首先调度全网盘搜引擎查找夸克分享源。",
    })
    yield emit({
        "type": "node",
        "node_type": "action",
        "title": "Action [调用盘搜工具]",
        "content": f"调用全网夸克盘搜接口检索关键词: '{m_title}'",
        "tool": "quark_search_share",
    })

    # 执行真实盘搜
    raw_results = await search_resources(query=m_title, deep=payload.deep or False)
    if not raw_results and m_year and m_year in m_title:
        cleaned_title = m_title.replace(m_year, "").strip()
        raw_results = await search_resources(query=cleaned_title, deep=payload.deep or False)

    if not raw_results:
        yield emit({"type": "bus", "step": 1, "status": "error", "sub": "未检索到资源"})
        yield emit({
            "type": "node",
            "node_type": "self-healing",
            "title": "Error [未命中资源]",
            "content": f"盘搜超时或未检索到与《{m_title}》相关的夸克分享链接，可点击重新尝试或切换手动模式。",
        })
        yield emit({"type": "error", "message": f"盘搜超时或未检索到与《{m_title}》相关的夸克分享链接，请重试或切换手动模式。"})
        yield "data: [DONE]\n\n"
        return

    yield emit({"type": "bus", "step": 1, "status": "done", "sub": f"共 {len(raw_results)} 条候选"})
    yield emit({
        "type": "node",
        "node_type": "observation",
        "title": "Observation [工具返回结果]",
        "content": f"全网检索完成，共获取到 {len(raw_results)} 条夸克分享候选源。",
    })

    # Step 2: 启发式质检（0ms，低延迟优先，初判前不做 LLM 与探针）
    yield emit({"type": "bus", "step": 2, "status": "active", "sub": "画质与纯净度评分..."})
    yield emit({
        "type": "node",
        "node_type": "thought",
        "title": "Thought [启发式画质初筛]",
        "content": "根据 4K UHD、杜比视界/HDR、蓝光REMUX与全集特征进行高精度打标算分，并过滤公众号与解压密码引流垃圾。",
    })

    ranked_data = await evaluate_and_rank_resources(items=raw_results, media_info=media_info, use_ai=True)
    ranked_items = ranked_data.get("items", [])
    if not ranked_items:
        yield emit({"type": "bus", "step": 2, "status": "error", "sub": "无可评分候选"})
        yield emit({"type": "error", "message": f"《{m_title}》检索结果均不可用，建议更换关键词或开启深度搜索。"})
        yield "data: [DONE]\n\n"
        return

    top_cand = ranked_items[0]
    yield emit({"type": "bus", "step": 2, "status": "done", "sub": f"优选 {top_cand.get('ai_score', 80)}分"})

    # 立即推送初判决策（不等目录探测，前端可在 1~2 秒内先渲染可交互卡片）
    yield emit({
        "type": "final",
        "data": _build_pilot_decision(
            m_title, m_year, m_type, m_season, top_cand, None, ranked_items, provisional=True
        ),
    })

    # Step 3: 并发探针下探与自愈（延迟取决于最慢的一条，而非串行累加）
    yield emit({"type": "bus", "step": 3, "status": "active", "sub": "并发探查目录树..."})
    yield emit({
        "type": "node",
        "node_type": "action",
        "title": "Action [并发探查分享目录树]",
        "content": f"并行探测前 {min(3, len(ranked_items))} 个候选的正片目录，避免串行等待。",
        "tool": "quark_inspect_tree",
    })

    chosen_candidate = None
    diagnosis = None
    fallback_attempts = 0

    probe_candidates = [c for c in ranked_items[:2] if c.get("shareurl")]

    async def _probe(cand: Dict[str, Any]) -> Dict[str, Any]:
        # 上游 /get_share_detail 偶发 20s 超时，这里收紧单请求超时与扫描量
        return await explore_share_tree(
            shareurl=cand.get("shareurl", ""),
            max_depth=2,
            max_scan_folders=3,
            request_timeout=5.0,
        )

    try:
        probe_results = await asyncio.wait_for(
            asyncio.gather(*[_probe(c) for c in probe_candidates], return_exceptions=True),
            timeout=9.0,
        )
    except asyncio.TimeoutError:
        probe_results = [{"success": False} for _ in probe_candidates]

    any_probe_success = False
    for idx, (cand, probe) in enumerate(zip(probe_candidates, probe_results)):
        if isinstance(probe, Exception) or not (probe.get("success") and probe.get("targets")):
            yield emit({
                "type": "node",
                "node_type": "self-healing",
                "title": "Self-Healing [自愈探针触发]",
                "content": f"第 {idx + 1} 顺位源无法解析或已被分享者取消，智能体自动切换至下一候选...",
            })
            continue

        any_probe_success = True
        diag = diagnose_share_structure_and_rename(share_tree=probe, media_info=media_info)
        # 严格质量红线：必须至少包含 1 个有效视频文件，绝不向用户推荐空包或死链！
        if diag and diag.get("video_count", 0) > 0:
            chosen_candidate = cand
            diagnosis = diag
            fallback_attempts = idx
            break

        yield emit({
            "type": "node",
            "node_type": "self-healing",
            "title": "Self-Healing [空包自愈降级]",
            "content": f"第 {idx + 1} 顺位候选探查完成但有效正片视频数量为 0 (疑似空壳包或纯引流文本)，智能体自动剔除并切换至下一候选...",
        })

    if not chosen_candidate or not diagnosis or diagnosis.get("video_count", 0) == 0:
        # 若探测确实成功但全是空包，仍坚持质量红线；若探测接口本身超时/不可用，则保留初判
        if any_probe_success:
            yield emit({"type": "bus", "step": 3, "status": "error", "sub": "正片文件缺失"})
            yield emit({
                "type": "error",
                "message": "未能匹配到包含有效正片视频文件的夸克分享源（检索到的资源为空壳包或已被分享者删除）。建议切换至【专家手动模式】开启【深度搜索】重新检索。"
            })
            yield "data: [DONE]\n\n"
            return

        yield emit({"type": "bus", "step": 3, "status": "done", "sub": "目录校验未完成，已保留初判"})
        yield emit({
            "type": "node",
            "node_type": "observation",
            "title": "Observation [保留初判]",
            "content": "分享目录校验接口响应超时，已保留初判优选资源。可直接转存，或稍后点击【AI透视】复核。",
        })
        fallback_payload = _build_pilot_decision(
            m_title, m_year, m_type, m_season, ranked_items[0], None, ranked_items,
            provisional=False, verified=False,
        )
        fallback_payload["fallback_recovered"] = False
        fallback_payload["fallback_from_idx"] = 0
        yield emit({"type": "final", "data": fallback_payload})
        yield "data: [DONE]\n\n"
        return

    levels_skipped = diagnosis.get("levels_skipped", 0) if diagnosis else 0
    video_count = diagnosis.get("video_count", 0) if diagnosis else 0
    target_name = diagnosis.get("target_name", "根目录") if diagnosis else "根目录"
    spam_count = diagnosis.get("spam_files_count", 0) if diagnosis else 0

    sub_probe = f"穿透 {levels_skipped} 层" if levels_skipped > 0 else "单层正片直达"
    if fallback_attempts > 0:
        sub_probe = f"自愈切次优 · {sub_probe}"
    yield emit({"type": "bus", "step": 3, "status": "done", "sub": sub_probe})
    yield emit({
        "type": "node",
        "node_type": "observation",
        "title": "Observation [目录树穿透完成]",
        "content": f"成功跳过 {levels_skipped} 层包装外壳，定位正片目录【{target_name}】(共 {video_count} 个视频){f'，已屏蔽 {spam_count} 个垃圾广告' if spam_count > 0 else ''}。",
    })

    # Step 4: 计算路径与标准重命名（用真实诊断结果修正初判）
    yield emit({"type": "bus", "step": 4, "status": "active", "sub": "计算 Emby 命名与路径..."})

    is_boxset = bool(diagnosis and diagnosis.get("is_multi_season"))
    final_payload = _build_pilot_decision(
        m_title, m_year, m_type, m_season, chosen_candidate, diagnosis, ranked_items,
        provisional=False, verified=True,
    )
    final_payload["fallback_recovered"] = fallback_attempts > 0
    final_payload["fallback_from_idx"] = fallback_attempts
    suggested_fn = diagnosis.get("suggested_filename", final_payload["taskname"]) if diagnosis else final_payload["taskname"]

    if is_boxset:
        distinct_seasons = diagnosis.get("distinct_seasons", [])
        yield emit({
            "type": "node",
            "node_type": "observation",
            "title": "Observation [全季大合集锁定]",
            "content": f"识别到多季大合集 (涵盖 {len(distinct_seasons)} 个季度，共 {diagnosis.get('video_count', 0)} 个视频)，已自动启用【全季整套转存模式】，落地于剧集母目录，避免漏存其余季度！",
        })

    yield emit({"type": "bus", "step": 4, "status": "done", "sub": "全季规范就绪" if is_boxset else "规范已就绪"})
    yield emit({
        "type": "node",
        "node_type": "thought",
        "title": "Thought [媒体入库决策]",
        "content": f"决策闭环: 应用 Emby/Plex 标准规范命名 -> '{suggested_fn}'，网盘目标落地路径 -> '{final_payload['savepath']}'。",
    })

    yield emit({"type": "final", "data": final_payload})
    yield "data: [DONE]\n\n"


@router.post("/auto-pilot-stream")
async def auto_pilot_stream_endpoint(payload: AutoPilotPayload):
    """Auto-Pilot 真实 SSE 流式端点"""
    return StreamingResponse(
        auto_pilot_stream_generator(payload),
        media_type="text/event-stream;charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/patterns")
async def get_pattern_presets():
    """获取可用命名正则与 QAS 实例真实的魔法变量"""
    magic = await get_magic_regex()
    presets = [
        {
            "id": ".*",
            "name": "保持原名并转存全量文件 (.*) [推荐/最稳妥]",
            "pattern": ".*",
            "replace": "",
            "is_magic": False,
        }
    ]
    if "$TV" in magic:
        presets.append({
            "id": "$TV",
            "name": "智能剧集命名与重命名 ($TV) [QAS内置魔法变量]",
            "pattern": "$TV",
            "replace": "",
            "is_magic": True,
        })
    presets.append({
        "id": r"\.(mp4|mkv|avi|mov|flv|ts|wmv)$",
        "name": "仅常见视频文件 (.mp4/.mkv等)",
        "pattern": r"\.(mp4|mkv|avi|mov|flv|ts|wmv)$",
        "replace": "",
        "is_magic": False,
    })
    for k, v in magic.items():
        if k != "$TV":
            presets.append({
                "id": k,
                "name": f"自定义魔法变量 ({k})",
                "pattern": k,
                "replace": v.get("replace", "") if isinstance(v, dict) else "",
                "is_magic": True,
            })
    return {"success": True, "presets": presets, "magic_regex": magic}


@router.post("/verify")
async def test_qas_connection():
    """测试 QAS 服务连通性与 Cookie 有效性"""
    return await verify_qas_connection()


@router.get("/search")
async def search_quark_resources(
    q: str = Query(..., description="搜索关键词"),
    deep: bool = Query(False, description="是否深度搜索"),
    media_title: Optional[str] = Query(None, description="影视标题"),
    media_year: Optional[str] = Query(None, description="影视年份"),
    media_type: Optional[str] = Query(None, description="媒体类型: movie, tv 等"),
    season: Optional[str] = Query(None, description="季数编号"),
    ai_rank: bool = Query(True, description="是否启用 AI 质检与智能打标排序"),
):
    """通过 QAS 检索夸克分享资源，并由 AI 进行智能画质质检、防引流过滤与优先排序"""
    raw_results = await search_resources(query=q, deep=deep)
    
    media_info = {
        "title": media_title or q,
        "year": media_year or "",
        "media_type": media_type or "movie",
        "season": season or "01",
    }
    
    ranked_data = await evaluate_and_rank_resources(
        items=raw_results,
        media_info=media_info,
        use_ai=ai_rank,
    )
    
    return {
        "success": True,
        "count": len(ranked_data.get("items", [])),
        "items": ranked_data.get("items", []),
        "evaluator": ranked_data.get("evaluator", "none"),
        "ai_used": ranked_data.get("ai_used", False),
        "can_refine": ranked_data.get("can_refine", False),
    }


class AiRefinePayload(BaseModel):
    items: List[Dict[str, Any]] = Field(..., description="待深度质检的头部候选列表")
    media_info: Optional[Dict[str, Any]] = Field(default=None, description="影视元数据")


@router.post("/ai-refine")
async def refine_search_results(payload: AiRefinePayload):
    """异步轻量 LLM 深度精审接口：由大模型仲裁首推与优化一句话评语"""
    refined_items = await refine_with_llm(
        top_candidates=payload.items,
        media_info=payload.media_info,
    )
    return {
        "success": True,
        "items": refined_items,
    }


@router.post("/share-detail")
async def inspect_share(payload: Dict[str, Any]):
    """解析夸克分享链接信息"""
    shareurl = payload.get("shareurl", "")
    if not shareurl:
        raise HTTPException(status_code=400, detail="缺少 shareurl 参数")
    return await get_share_detail(shareurl=shareurl, task=payload.get("task"))


@router.post("/explore-share")
async def explore_share(payload: ExploreSharePayload):
    """
    递归深度探测夸克分享链接的目录树：
    自动下探多层包装目录，识别各季度（Season 01/02）与独立视频子目录
    """
    try:
        return await asyncio.wait_for(
            explore_share_tree(
                shareurl=payload.shareurl,
                max_depth=payload.max_depth or 4,
                max_scan_folders=8,
                request_timeout=5.0,
            ),
            timeout=9.0,
        )
    except asyncio.TimeoutError:
        return {"success": False, "message": "分享目录探测超时（9s），请稍后重试。", "targets": []}


@router.post("/add-task", dependencies=[Depends(require_admin)])
async def create_auto_save_task(task: TaskPayload):
    """创建转存任务（加入定时追更，受管理员权限保护）"""
    return await add_task(task.model_dump())


@router.post("/batch-add-tasks", dependencies=[Depends(require_admin)])
async def batch_create_auto_save_tasks(payload: BatchTasksPayload):
    """批量创建转存任务（多季自动拆分时批量下发，受管理员权限保护）"""
    results = []
    success_count = 0
    for task in payload.tasks:
        res = await add_task(task.model_dump())
        if res.get("success"):
            success_count += 1
        results.append({"taskname": task.taskname, "result": res})
    return {
        "success": success_count > 0,
        "total": len(payload.tasks),
        "success_count": success_count,
        "details": results,
    }


@router.post("/run-now", dependencies=[Depends(require_admin)])
async def run_task_immediately(payload: Dict[str, Any]):
    """立即执行转存（返回 SSE 流式执行日志，受管理员权限保护）"""
    tasklist = payload.get("tasklist", [])

    return StreamingResponse(
        run_task_stream(tasklist),
        media_type="text/event-stream;charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/tasks", dependencies=[Depends(require_admin)])
async def list_tasks():
    """获取 QAS 现有任务列表（受管理员权限保护）"""
    return await get_tasks()


@router.delete("/task/{taskname}", dependencies=[Depends(require_admin)])
async def remove_task(taskname: str):
    """删除 QAS 任务（受管理员权限保护）"""
    return await delete_task(taskname)


@router.post("/batch-delete", dependencies=[Depends(require_admin)])
async def batch_remove_tasks(payload: BatchDeletePayload):
    """批量删除 QAS 任务（受管理员权限保护）"""
    return await batch_delete_tasks(payload.tasknames)


@router.post("/resolve-path")
async def resolve_save_path(payload: ResolvePathPayload):
    """根据本系统配置的路径规则与媒体信息计算目标网盘保存路径"""
    result = calculate_save_path(
        media_type=payload.media_type,
        title=payload.title,
        year=payload.year or "",
        season=payload.season or "01",
        resolution=payload.resolution or "4K",
        whole_folder=payload.whole_folder if payload.whole_folder is not None else True,
    )
    return {
        "success": True,
        "resolved_path": result["resolved_path"],
        "series_root": result["series_root"],
        "template_used": result["template_used"],
    }
