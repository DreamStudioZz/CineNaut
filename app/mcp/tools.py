import json
from typing import Any, Callable, Dict, List, Optional
from app.core.config import get_config
from app.core.qas_client import (
    add_task,
    explore_share_tree,
    get_tasks,
    search_resources,
    verify_qas_connection,
)
from app.api.qas import calculate_save_path
from app.core.llm_evaluator import (
    diagnose_share_structure_and_rename,
    evaluate_and_rank_resources,
)

# ============================================================
# Model Context Protocol (MCP) 标准工具集规范定义
# 符合 Anthropic / MCP 官方标准 Tool Definition 规范
# ============================================================

MCP_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "quark_search_share",
        "description": "全网检索夸克网盘分享资源（支持普通检索与深度全网盘搜）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，如影视剧名、电影名（可带年份）",
                },
                "deep": {
                    "type": "boolean",
                    "description": "是否启用深度聚合搜索，默认为 false",
                    "default": False,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "quark_inspect_tree",
        "description": "递归探测夸克分享链接目录树，穿透空壳套娃目录并定位底层正片文件",
        "inputSchema": {
            "type": "object",
            "properties": {
                "shareurl": {
                    "type": "string",
                    "description": "夸克网盘分享完整链接 (https://pan.quark.cn/s/...)",
                },
                "max_depth": {
                    "type": "integer",
                    "description": "最大递归探测深度（默认4层）",
                    "default": 4,
                },
                "media_title": {
                    "type": "string",
                    "description": "影视标准标题，用于生成规范重命名",
                },
                "year": {
                    "type": "string",
                    "description": "影视年份",
                },
                "media_type": {
                    "type": "string",
                    "description": "媒体类型: movie, tv, anime, variety, doc",
                    "default": "movie",
                },
                "season": {
                    "type": "string",
                    "description": "季数编号，如 01",
                    "default": "01",
                },
            },
            "required": ["shareurl"],
        },
    },
    {
        "name": "quark_resolve_save_path",
        "description": "根据系统预设的路径模板与影视元数据，计算目标网盘保存路径",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "片名或剧名",
                },
                "media_type": {
                    "type": "string",
                    "description": "媒体类型: movie, tv, anime, variety, doc",
                    "default": "movie",
                },
                "year": {
                    "type": "string",
                    "description": "上映年份",
                },
                "season": {
                    "type": "string",
                    "description": "季数编号",
                    "default": "01",
                },
                "resolution": {
                    "type": "string",
                    "description": "画质分辨率，如 4K, 1080P",
                    "default": "4K",
                },
            },
            "required": ["title"],
        },
    },
    {
        "name": "quark_add_transfer_task",
        "description": "向 Quark-Auto-Save (QAS) 调度引擎下发转存任务（支持加入定时追更）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "taskname": {
                    "type": "string",
                    "description": "转存任务名称（通常为片名/剧名）",
                },
                "shareurl": {
                    "type": "string",
                    "description": "夸克分享直达链接",
                },
                "savepath": {
                    "type": "string",
                    "description": "网盘目标保存目录",
                },
                "pattern": {
                    "type": "string",
                    "description": "命名匹配正则或魔法变量（如 $TV 或保留后缀正则）",
                    "default": ".*",
                },
                "replace": {
                    "type": "string",
                    "description": "重命名替换模板（如 电影名 (年份)$1）",
                    "default": "",
                },
                "update_subdir": {
                    "type": "string",
                    "description": "子目录递归透传规则，默认 .*",
                    "default": ".*",
                },
            },
            "required": ["taskname", "shareurl", "savepath"],
        },
    },
    {
        "name": "quark_check_system_status",
        "description": "检查当前 QAS 服务的连通性、Cookie 状态、定时追更任务列表与网盘环境",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
]


# ============================================================
# MCP 工具实际执行分发器 (Tool Execution Handlers)
# ============================================================

async def handle_search_share(arguments: Dict[str, Any]) -> Dict[str, Any]:
    query = arguments.get("query", "").strip()
    deep = bool(arguments.get("deep", False))
    if not query:
        return {"success": False, "error": "缺少 query 参数"}
    results = await search_resources(query=query, deep=deep)
    return {
        "success": True,
        "count": len(results),
        "items": results[:15],  # 截取前 15 条返回给 Agent 上下文
    }


async def handle_inspect_tree(arguments: Dict[str, Any]) -> Dict[str, Any]:
    shareurl = arguments.get("shareurl", "").strip()
    max_depth = int(arguments.get("max_depth", 4))
    if not shareurl:
        return {"success": False, "error": "缺少 shareurl 参数"}

    tree_res = await explore_share_tree(shareurl=shareurl, max_depth=max_depth)
    if not tree_res.get("success"):
        return tree_res

    media_info = {
        "title": arguments.get("media_title", ""),
        "year": arguments.get("year", ""),
        "media_type": arguments.get("media_type", "movie"),
        "season": arguments.get("season", "01"),
    }
    diagnosis = diagnose_share_structure_and_rename(
        share_tree=tree_res,
        media_info=media_info,
    )
    return {
        "success": True,
        "tree_summary": {
            "title": tree_res.get("share_title"),
            "targets_count": tree_res.get("targets_count"),
            "is_multi_target": tree_res.get("is_multi_target"),
        },
        "diagnosis": diagnosis,
    }


async def handle_resolve_save_path(arguments: Dict[str, Any]) -> Dict[str, Any]:
    title = arguments.get("title", "").strip()
    if not title:
        return {"success": False, "error": "缺少 title 参数"}
    return calculate_save_path(
        media_type=arguments.get("media_type", "movie"),
        title=title,
        year=arguments.get("year", ""),
        season=arguments.get("season", "01"),
        resolution=arguments.get("resolution", "4K"),
        whole_folder=True,
    )


async def handle_add_transfer_task(arguments: Dict[str, Any]) -> Dict[str, Any]:
    taskname = arguments.get("taskname", "").strip()
    shareurl = arguments.get("shareurl", "").strip()
    savepath = arguments.get("savepath", "").strip()
    if not taskname or not shareurl or not savepath:
        return {"success": False, "error": "缺少必须参数: taskname, shareurl 或 savepath"}

    task_payload = {
        "taskname": taskname,
        "shareurl": shareurl,
        "savepath": savepath,
        "pattern": arguments.get("pattern", ".*"),
        "replace": arguments.get("replace", ""),
        "update_subdir": arguments.get("update_subdir", ".*"),
        "ignore_extension": False,
        "runweek": [1, 2, 3, 4, 5, 6, 7],
    }
    return await add_task(task_payload)


async def handle_check_system_status(arguments: Dict[str, Any]) -> Dict[str, Any]:
    conn = await verify_qas_connection()
    tasks_res = await get_tasks()
    tasklist = tasks_res.get("data", {}).get("tasklist", []) if tasks_res.get("success") else []
    return {
        "success": True,
        "connection": conn,
        "active_tasks_count": len(tasklist),
        "tasks_summary": [{"taskname": t.get("taskname"), "savepath": t.get("savepath")} for t in tasklist[:10]],
    }


TOOL_HANDLERS: Dict[str, Callable] = {
    "quark_search_share": handle_search_share,
    "quark_inspect_tree": handle_inspect_tree,
    "quark_resolve_save_path": handle_resolve_save_path,
    "quark_add_transfer_task": handle_add_transfer_task,
    "quark_check_system_status": handle_check_system_status,
}


def list_tools() -> List[Dict[str, Any]]:
    """返回全部 MCP 工具定义列表（遵循 MCP 标准）"""
    return MCP_TOOLS


async def execute_tool(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """统一执行指定的 MCP 工具"""
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return {
            "success": False,
            "error": f"未找到指定的 MCP 工具: [{name}]",
            "available_tools": list(TOOL_HANDLERS.keys()),
        }
    try:
        return await handler(arguments or {})
    except Exception as e:
        return {
            "success": False,
            "error": f"执行 MCP 工具 [{name}] 异常: {str(e)}",
        }
