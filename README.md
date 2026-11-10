# CineNaut

> 影视发现 + 夸克网盘自动转存的一体化控制台。

CineNaut 把「找片 → 选源 → 转存 → 追更」串成一条链路：TMDB 负责发现，PanSou / CloudSaver 负责盘搜，Auto-Pilot 负责自动选源、目录穿透与 Emby/Plex 规范命名，Quark-Auto-Save (QAS) 负责真正落盘。

项目使用 FastAPI + 原生 HTML/CSS/JS，无前端构建步骤；界面采用米纸 / 墨线 / 等宽标注的纸质工匠风格。

---

## 目录

- [功能特性](#功能特性)
- [界面与设计](#界面与设计)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [使用流程](#使用流程)
- [项目结构](#项目结构)
- [API 一览](#api-一览)
- [关键设计](#关键设计)
- [安全建议](#安全建议)
- [已知限制](#已知限制)
- [License](#license)

---

## 功能特性

### 1. 影视发现（TMDB）

- 热门电影、最新电影、高分佳片、冷门佳片、热门剧集、动画、综艺、纪录片。
- 华语 / 欧美 / 日本 / 韩国 / 全部地区过滤。
- 顶栏全局搜索 + 即时联想。
- 内置 TMDB 图片代理，解决国内直连 `image.tmdb.org` 丢包、海报红叉的问题。
- 列表与搜索接口带 5 分钟内存缓存。

### 2. Auto-Pilot 智能托管

点击海报后自动完成：

1. 聚合盘搜（PanSou / CloudSaver），拿到全网夸克分享候选。
2. 启发式质检：4K / 2160 / UHD、HDR / 杜比、REMUX / 蓝光原盘、全集完结、广告引流、枪版等特征打分与排序。
3. **低延迟初判**：盘搜返回后立即推送一版决策，用户可先操作，不用等目录探测。
4. **并发探针**：Top 候选并发探查分享树，自动穿透套娃目录、识别多季合集、过滤空包与死链。
5. 计算目标网盘路径，生成 Emby/Plex 规范命名与 QAS 正则。
6. 通过 SSE 实时回显 Thought / Action / Observation 与阶段进度。

探针失败或上游目录接口超时时，会保留初判结果（`verified=false`），不会把已经可用的结果推翻。

> Auto-Pilot 依赖大模型配置：只有在系统设置里启用 AI（`llm_enabled=true`）时才会展示和调用；关闭 AI 后会强制进入专家手动模式。

### 3. 专家手动微调

- 主面板只展示 **Top 3**，其余结果进入独立结果弹窗：
  - 桌面：居中弹窗
  - 手机：底部抽屉
- 结果支持按 4K / 1080P / 其他筛选，按评分 / 更新时间排序。
- 可查看分享目录、正则重命名预览、AI 结构透视。
- 支持立即执行转存（SSE 实时日志）或加入 QAS 定时追更。

### 4. 任务与追更

- 实时同步 QAS 任务列表。
- 单任务立即运行、删除，支持批量删除。
- 执行日志实时回显，按钮状态、Toast 与错误信息完整反馈。

### 5. 配置与安全

- 电影 / 剧集 / 动画 / 综艺 / 纪录片 5 类保存路径模板。
- TMDB、QAS、LLM 连通性一键测试。
- 配置接口对密钥脱敏，只返回「是否已配置」；表单留空表示保持原值。
- 可选管理员密钥（`ADMIN_KEY`）：设置后，配置、任务、转存等接口需要鉴权。
- 前端首次通过 `/?key=xxx` 访问后，会把密钥存入 `sessionStorage` 并统一附加 `X-Admin-Key`。

---

## 界面与设计

- 米纸 `#f7f6f2` + 墨线 `#16150f` + 单一强调绿 `#1b7f43`。
- 等宽字体用于数据、步骤、路径与状态，正文使用系统无衬线。
- Auto-Pilot 等待态采用「精工刻度」：阶段区间内按时间连续爬升，SSE 事件到达时推进。
- 结果列表不再嵌套滚动：主面板只留 Top 3，完整结果进弹窗。
- `app/static/demo-*.html` 是设计对比页，可直接通过 `/static/demo-*.html` 预览。

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:8000
```

配置会持久化在宿主机 `./data/config.json`，重启或升级容器不会丢失。

如果设置了 `ADMIN_KEY`，第一次访问请带上密钥：

```text
http://localhost:8000/?key=你的密钥
```

之后同一标签页会自动记住并改用 `X-Admin-Key` 请求头。

### 方式二：本地 Python

要求 Python 3.11+。

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

访问 `http://localhost:8000`。

### 首次配置

进入左侧「系统配置」，至少填写：

| 配置 | 是否必需 | 说明 |
|---|---|---|
| TMDB API Key | 必需 | 影视发现与搜索 |
| QAS 服务地址 / Token | 必需 | 盘搜、目录探测、转存 |
| LLM Base URL / Key / Model | Auto-Pilot 必需 | OpenAI 兼容接口，如 DeepSeek、OpenAI、Kimi、Ollama |
| 保存路径模板 | 建议 | 决定网盘落盘目录与命名 |

配置完成后可用卡片上的「测试连通性」逐项检查。

---

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATA_DIR` | `data` | 配置与运行时数据目录；Docker 内为 `/app/data` |
| `ADMIN_KEY` | 空 | 管理员密钥；设置后受保护接口需要鉴权 |
| `TZ` | 系统默认 | 容器时区，compose 中为 `Asia/Shanghai` |

### 配置文件

运行时配置保存在 `data/config.json`（已 gitignore）。主要字段：

```jsonc
{
  "tmdb_api_key": "",
  "tmdb_base_url": "https://api.themoviedb.org",
  "tmdb_image_base_url": "https://image.tmdb.org",
  "proxy": "",
  "qas_base_url": "http://localhost:5005",
  "qas_token": "",
  "admin_key": "",
  "llm_enabled": true,
  "llm_base_url": "https://api.deepseek.com/v1",
  "llm_api_key": "",
  "llm_model": "deepseek-chat",
  "path_movie": "nas/movie/{片名} ({年份})",
  "path_tv": "nas/TV/{剧名} ({年份})/{剧名} - S{季数}",
  "path_anime": "nas/动画/{剧名} ({年份})/{剧名} - S{季数}",
  "path_variety": "nas/综艺/{剧名} ({年份})/{剧名} - S{季数}",
  "path_doc": "纪录片/{剧名} ({年份})/{剧名} - S{季数}"
}
```

> 通过设置页保存时，密钥字段留空表示「保持原值」；未提交的字段（如 `admin_key`）也会保持原值。

### 路径模板变量

| 变量 | 说明 |
|---|---|
| `{片名}` / `{剧名}` | 影视标题 |
| `{年份}` | 上映 / 首播年份 |
| `{季数}` | 两位季数，如 `01` |
| `{分辨率}` | 从候选标签与标题中识别的 `4K` / `1080P` / `720P` / `480P` |

示例：

```text
nas/TV/{剧名} ({年份})/{剧名} - S{季数}
```

---

## 使用流程

### Auto-Pilot

1. 在发现页点击任意海报。
2. 默认进入 Auto-Pilot，等待刻度走完初判。
3. 查看首推资源、目标路径与命名规则。
4. 点击「立即执行转存」或「加入后台追更」。
5. 如需重新检索，切换「专家手动微调」或点击重试。

### 专家手动微调

1. 切到「专家手动微调」。
2. 输入关键词，点击「检索资源」。
3. 主面板查看 Top 3；点「查看全部」打开结果弹窗。
4. 在弹窗中筛选 / 排序 / 选用。
5. 确认分享链接、保存路径与命名规则后执行。

### 任务列表

左侧「转存任务列表」可查看 QAS 后台任务，支持单条立即运行、删除与批量删除。

---

## 项目结构

```text
.
├── app/
│   ├── main.py                 # FastAPI 入口、路由注册、静态资源
│   ├── api/
│   │   ├── auth.py             # 管理员密钥状态与校验
│   │   ├── config.py           # 配置读写（密钥脱敏、字段合并）
│   │   ├── tmdb.py             # TMDB 发现 / 搜索 / 图片代理
│   │   └── qas.py              # QAS 搜索、目录探测、Auto-Pilot、任务、路径解析
│   ├── core/
│   │   ├── auth.py             # 管理员密钥校验
│   │   ├── config.py           # AppConfig 与持久化
│   │   ├── tmdb_client.py      # TMDB 客户端与缓存
│   │   ├── qas_client.py       # QAS 客户端、搜索/目录树缓存
│   │   └── llm_evaluator.py    # 启发式质检、LLM 精审、目录诊断与命名
│   ├── mcp/tools.py            # MCP 工具定义（预留）
│   └── static/                 # 前端页面、样式、脚本与设计演示页
├── data/config.json            # 运行时配置（gitignore）
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── README.md
```

---

## API 一览

完整交互式文档：`http://localhost:8000/docs`

| 分类 | 端点 | 说明 |
|---|---|---|
| 权限 | `GET /api/auth/status`、`POST /api/auth/verify` | 权限状态与密钥校验 |
| 配置 | `GET/POST /api/config`、`POST /api/config/test-llm` | 读取 / 保存配置、测试 LLM |
| TMDB | `GET /api/tmdb/discover`、`GET /api/tmdb/search`、`GET /api/tmdb/image`、`POST /api/tmdb/verify` | 发现、搜索、海报代理、连通性 |
| 盘搜 | `GET /api/qas/search`、`POST /api/qas/ai-refine` | 聚合搜索与 LLM 精审 |
| Auto-Pilot | `POST /api/qas/auto-pilot-stream`、`POST /api/qas/auto-pilot` | 流式 / 非流式智能托管 |
| 目录 | `POST /api/qas/explore-share`、`POST /api/qas/explore-share-ai`、`POST /api/qas/share-detail` | 目录树探测、AI 结构透视 |
| 任务 | `POST /api/qas/add-task`、`POST /api/qas/batch-add-tasks`、`GET /api/qas/tasks`、`DELETE /api/qas/task/{taskname}`、`POST /api/qas/batch-delete` | 转存任务管理 |
| 执行 | `POST /api/qas/run-now` | SSE 实时执行日志 |
| 路径 | `POST /api/qas/resolve-path`、`GET /api/qas/patterns` | 路径模板解析、命名预设 |

---

## 关键设计

### 低延迟 Auto-Pilot

- 盘搜 + 启发式评分后，立即通过 SSE 推送 `provisional=true` 的初判决策。
- 初判之后才并发探测 Top 2 候选的分享树：单请求 5s、每候选最多 3 个目录、总预算 9s。
- AI 结构透视同样有 9s 总预算（单请求 5s、最多 8 个目录），超时直接返回提示。
- 探测成功则推送 `verified=true` 的最终决策；探测失败则保留初判，返回 `verified=false`，不阻断用户。
- 盘搜结果缓存 5 分钟，目录树缓存 2 分钟；盘搜超时时有旧结果兜底。

### 质检与命名

- 启发式规则覆盖 4K / 2160 / UHD、HDR / 杜比、REMUX / 蓝光原盘、1080P / 720P、枪版 / 预告、广告引流、全集 / 连载等特征。
- `{分辨率}` 从标签与标题中提取干净值，不会把「推荐优选」等展示标签写进路径。
- 目录诊断会识别多季合集、穿透套层目录、屏蔽根目录引流文件，并生成 Emby/Plex 命名与 QAS 正则。

### 前端交互

- Auto-Pilot 等待态：精工刻度 + 实时耗时。
- 结果列表：主面板 Top 3，完整结果进弹窗（桌面居中 / 手机底部抽屉）。
- 执行反馈：按钮 loading、Toast、实时日志、HTTP 错误详情。
- 打开新影片会清空上一部影片的结果 DOM，避免串台。

---

## 安全建议

- **公网部署时务必设置 `ADMIN_KEY`**，否则配置、任务与转存接口默认开放。
- `data/config.json` 以明文保存 API Key / Token，请确保宿主机文件权限受控，不要提交到仓库。
- 配置接口已对密钥脱敏；设置页留空表示保持原值。
- 建议通过反向代理启用 HTTPS，并把管理员密钥放在请求头或首次 `?key=` 中，避免长期留在地址栏。

---

## 已知限制

- 盘搜依赖上游 QAS / PanSou / CloudSaver，首次搜索可能需要 5～30 秒，偶发超时。
- 搜索缓存目前是进程内缓存，重启后会清空。
- Auto-Pilot 需要 OpenAI 兼容的大模型接口；未启用 AI 时不会展示。
- 目前没有自动化测试；依赖版本使用 `>=` 范围，生产部署建议自行锁定。
- 手机端顶部搜索入口仍是紧凑样式，设计对比页已提供但尚未落地。
- `app/mcp/tools.py` 为预留的 MCP 工具定义，尚未暴露为 MCP Server。

---

## License

[MIT](LICENSE) © 2026 DreamStudioZz
