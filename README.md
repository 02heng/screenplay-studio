# 剧本生成工作台 (Screenplay Studio)

Electron + **FastAPI** 本地工作台，首期支持三类流水线：**院线长剧本**、**短剧**、**小说节选改编**。LLM 通过 **多套 OpenAI 兼容预设**接入（可复制 `providers.example.yaml`）。

与姐妹项目 AI-writer 分离；集成方式对齐：主进程拉起 `uvicorn`，默认端口 **`18766`**（避免占用 AI-writer 的 `18765`）。

## 参考项目（方法论，非直接 Fork）

- [google-deepmind/dramatron](https://github.com/google-deepmind/dramatron) — 层级化解构长剧本思路
- [ruvnet/aiscreenplay](https://github.com/ruvnet/aiscreenplay) — 场景模板与传统版式参考
- [0xsline/short-drama](https://github.com/0xsline/short-drama)、[oidahdsah0/llm-script-factory](https://github.com/oidahdsah0/llm-script-factory) — 短剧节奏与钩子可参考
- [crewAI screenplay_writer example](https://github.com/crewAIInc/crewAI-examples/tree/main/crews/screenplay_writer) — 日后多 Agent 扩展参考

## 数据目录（D 盘优先）

Windows 下优先使用 **`D:\Screenplay-Studio-data`**：`UserData`、`Downloads`、`Logs`、`Cache` 等均尽量放在该树下。若不可用，可设置环境变量 **`SCREENPLAY_DATA_ROOT`** 指向其它盘符路径。

导出文件对话框默认偏好 **同一数据根下的 `Downloads`**，符合「尽量少写 C 盘」的习惯。

## LLM 配置

1. 复制 `backend/config/providers.example.yaml` 到以下路径之一（任选），并按厂商说明设置密钥**环境变量**（不要把 Key 写入仓库）：
   - `D:\Screenplay-Studio-data\UserData\providers.yaml`（Electron 推荐），或
   - `backend/config/providers.yaml`（本地开发）。

2. 在 `UserData\.env` 或 `backend\.env` 中写入密钥，参见 `backend/.env.example`。

首期使用 **OpenAI 兼容 `/v1/chat/completions` 流式**；可按需在预设里填写 `extra_headers`。

## 本地运行

前置：Node.js、Python 3.10+。

若 `npm install` 下载 Electron 超时，可先设置环境变量（PowerShell）：  
`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron"`，然后再执行 `npm install`。

```powershell
cd backend
pip install -r requirements.txt
cd ..
npm install
```

**桌面一键开发**（Vite + Electron，`wait-on` 等端口就绪后再开 Electron）：

```powershell
npm run dev
```

**仅构建前端后启动桌面壳**（不调 Vite，加载 `renderer/dist`）：

```powershell
npm run build:renderer
npm start
```

（`npm start` 即 `electron .`。本机仍需已安装 Python 依赖：`pip install -r backend/requirements.txt`，便于主进程拉起 FastAPI。）

**打包 Windows 软件（NSIS 安装向导 + `release/`）**：

```powershell
pip install -r backend/requirements.txt
npm run dist
```

也可用 `npm run pack` 只生成解压即用的目录。安装包附带 `resources/backend` 源码；**最终用户暂不自带 Python**，需本机装有 Python 3.10+ 且能执行 `py -3`。要做免 Python 分发需另接 PyInstaller 冻结后端。

**仅启动后端调试**：

```powershell
npm run backend
```

健康检查：<http://127.0.0.1:18766/api/health> ，应返回 `app: screenplay-studio`、`pipeline_stream: true`。

## API 摘要

- `GET /api/health` — 版本与 `user_data` 路径。
- `GET /api/llm/presets` — 安全预设列表。
- `POST /api/jobs/stream` — 请求体 `job_type`（`feature` | `short_drama` | `novel_adapt`）、`preset_id`、`logline`、`novel_excerpt`、`notes`；以 `text/event-stream`（SSE）返回阶段与正文增量。

## 后续（非首期）

免安装 Python：PyInstaller 冻结后端并进 `extraResources`；小说向量切段、与 AI-writer 对齐的长记忆等。
