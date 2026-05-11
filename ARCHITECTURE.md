# Screenplay Studio — 全流程短剧平台架构设计文档

> 版本：v1.0  
> 日期：2026-05-09  
> 定位：从剧本到成片的国内短剧全流程 Electron + FastAPI 桌面平台

---

## 目录

1. [总体目标与设计原则](#1-总体目标与设计原则)
2. [现有模块盘点](#2-现有模块盘点)
3. [整体模块划分](#3-整体模块划分)
4. [全流程数据流](#4-全流程数据流)
5. [图片生成 API 插槽设计](#5-图片生成-api-插槽设计)
6. [视频生成 API 插槽设计](#6-视频生成-api-插槽设计)
7. [视频剪辑模块设计](#7-视频剪辑模块设计)
8. [数据库表设计（增量）](#8-数据库表设计增量)
9. [后端 Router 清单](#9-后端-router-清单)
10. [前端页面/Tab 规划](#10-前端页面tab-规划)
11. [新增/修改文件清单](#11-新增修改文件清单)
12. [实施优先级：MVP vs 完善版](#12-实施优先级mvp-vs-完善版)
13. [参考仓库关键借鉴点](#13-参考仓库关键借鉴点)

---

## 1. 总体目标与设计原则

### 目标
构建一个**端到端的国内短剧生产平台**，覆盖：

```
故事梗概 → 剧本生成 → 人物三视图 → 分镜制作 → 图片生成 → 视频生成 → 视频剪辑 → 导出成片
```

### 设计原则

| 原则 | 说明 |
|------|------|
| **只输出提示词** | 图片/视频生成不内置推理，仅调用外部 API；提示词由 LLM 生成 |
| **Provider 插槽化** | 图片/视频服务商通过 YAML 配置，运行时通过抽象层分发 |
| **流水线状态机** | 每个阶段有明确 `status`（pending/running/done/failed），支持断点续做 |
| **JSON 为核心数据格式** | 人物卡、分镜、剪辑时间线均以 JSON 字段存储，前端可直接消费 |
| **不锁定服务商** | 短剧题材标签、钩子、节奏模板来自提示词系统，不依赖任何云服务 |
| **本地数据优先** | 所有资产（图片/视频/剧本）保存在用户数据目录，隐私安全 |

---

## 2. 现有模块盘点

### 已有后端模块

| 文件路径 | 功能 |
|----------|------|
| `backend/app/main.py` | FastAPI 主入口，SSE 流式 job 端点 |
| `backend/app/db/models.py` | Project / Script / Character / Scene / StoryboardShot / EditShot |
| `backend/app/routers/projects.py` | 项目 CRUD |
| `backend/app/routers/scripts.py` | 剧本 CRUD |
| `backend/app/routers/characters.py` | 角色 CRUD + 参考图上传 |
| `backend/app/routers/storyboard.py` | Scene / StoryboardShot / EditShot CRUD |
| `backend/app/routers/assets.py` | 素材管理 |
| `backend/app/routers/settings.py` | LLM 设置 |
| `backend/app/routers/download.py` | 番茄小说下载 |
| `backend/app/routers/memory.py` | 记忆管理 |
| `backend/app/pipelines/runner.py` | 多阶段 LLM 流水线（SSE） |
| `backend/app/prompts/manifest.json` | 流水线阶段元数据 |
| `backend/config/providers.example.yaml` | LLM provider 插槽配置 |

### 已有前端模块

| 文件路径 | 功能 |
|----------|------|
| `renderer/src/pages/ProjectManager.tsx` | 项目列表页 |
| `renderer/src/pages/ProjectWorkspace.tsx` | 工作区（5个Tab） |
| `renderer/src/tabs/ScriptTab.tsx` | 剧本生成+编辑 |
| `renderer/src/tabs/CharactersTab.tsx` | 角色管理 |
| `renderer/src/tabs/StoryboardTab.tsx` | 分镜制作 |
| `renderer/src/tabs/EditScriptTab.tsx` | 剪辑脚本 |
| `renderer/src/tabs/AssetsTab.tsx` | 素材库 |

### 现有能力（可复用）

- ✅ LLM 多 Provider 配置（`providers.yaml`，OpenAI 兼容）
- ✅ 短剧/小说/长片三种流水线 SSE 流式输出
- ✅ 角色 CRUD + 参考图上传
- ✅ 分镜脚本（`ai_prompt` + `animation_prompt` 字段已存在）
- ✅ 剪辑时间线基础结构（EditShot 表）
- ✅ 番茄小说下载
- ✅ 提示词系统（钩子/大纲/人物分析/分镜导演/剪辑脚本）

### 缺失模块（需新增）

- ❌ 图片生成 Provider 抽象层
- ❌ 视频生成 Provider 抽象层
- ❌ 人物三视图（正面/侧面/背面提示词）生成与图片 API 对接
- ❌ 分镜 → 图片批量生成调度
- ❌ 分镜 → 视频批量生成调度
- ❌ 短剧集数规划（Episode 表）
- ❌ 视频剪辑时间线（拼接/字幕/BGM/转场）
- ❌ FFmpeg 合成导出
- ❌ 生成任务队列（Job Queue）

---

## 3. 整体模块划分

```
screenplay-studio/
├── backend/
│   └── app/
│       ├── main.py                    # 现有，需增加新路由注册
│       ├── db/
│       │   └── models.py              # 现有+扩展：Episode、GenerationJob、VideoClip、Timeline
│       ├── routers/
│       │   ├── projects.py            # 现有
│       │   ├── scripts.py             # 现有
│       │   ├── characters.py          # 现有，扩展三视图接口
│       │   ├── storyboard.py          # 现有，扩展批量生成触发
│       │   ├── assets.py              # 现有
│       │   ├── settings.py            # 现有，扩展图片/视频 provider 配置
│       │   ├── download.py            # 现有
│       │   ├── memory.py              # 现有
│       │   ├── episodes.py            # 新增：集数规划 CRUD
│       │   ├── generation.py          # 新增：图片/视频生成调度
│       │   └── editor.py              # 新增：视频剪辑时间线
│       ├── pipelines/
│       │   ├── runner.py              # 现有
│       │   └── episode_planner.py     # 新增：集数规划流水线
│       ├── providers/                 # 新增：媒体生成 Provider 抽象层
│       │   ├── __init__.py
│       │   ├── base.py                # AbstractImageProvider / AbstractVideoProvider
│       │   ├── image/
│       │   │   ├── comfyui.py
│       │   │   ├── dashscope.py       # 阿里云 Wanx
│       │   │   ├── volcengine.py      # 火山豆包图片
│       │   │   ├── kling_image.py     # 可灵图片
│       │   │   └── openai_dalle.py    # DALL·E 3 / GPT-image
│       │   └── video/
│       │       ├── kling.py           # 可灵视频
│       │       ├── volcengine.py      # 火山 Seedance
│       │       ├── dashscope.py       # 通义万相视频
│       │       ├── vidu.py
│       │       └── cogvideox.py       # CogVideoX（本地/API）
│       ├── editor/                    # 新增：剪辑引擎
│       │   ├── timeline.py            # 时间线组装逻辑
│       │   ├── subtitle.py            # SRT/ASS 字幕生成
│       │   └── ffmpeg_export.py       # FFmpeg 调用封装
│       └── prompts/                   # 现有+扩展
│           ├── character_triview.md   # 新增：三视图提示词
│           ├── episode_planner.md     # 新增：集数规划提示词
│           └── ... （现有文件不变）
├── renderer/src/
│   ├── pages/
│   │   ├── ProjectManager.tsx         # 现有
│   │   └── ProjectWorkspace.tsx       # 现有，扩展 Tab 列表
│   └── tabs/
│       ├── ScriptTab.tsx              # 现有
│       ├── CharactersTab.tsx          # 现有，扩展三视图 UI
│       ├── EpisodesTab.tsx            # 新增：集数规划
│       ├── StoryboardTab.tsx          # 现有，扩展批量生成按钮
│       ├── GenerationTab.tsx          # 新增：图片/视频生成监控面板
│       ├── VideoEditorTab.tsx         # 新增：视频剪辑时间线
│       ├── EditScriptTab.tsx          # 现有
│       └── AssetsTab.tsx              # 现有
└── backend/config/
    ├── providers.example.yaml         # 现有（LLM）
    └── media_providers.example.yaml   # 新增（图片/视频生成）
```

---

## 4. 全流程数据流

### 阶段概览

```
[1] 项目创建
      ↓ Project{type, genre_tags, aspect_ratio, total_episodes}
[2] 剧本生成（现有 SSE 流水线）
      ↓ Script{content, stage}
[3] 集数规划
      ↓ Episode[]{episode_no, title, hook_type, beat_summary, status}
[4] 人物分析 → 人物卡 JSON
      ↓ Character{name, description, character_card_json, ai_prompt}
[5] 人物三视图生成（LLM → 提示词 → 图片 API）
      ↓ Character{triview_prompt_front/side/back, triview_image_*}
[6] 分镜生成（LLM → 分镜 JSON）
      ↓ StoryboardShot{ai_prompt, animation_prompt, narration}
[7] 分镜图片生成（图片 API 插槽）
      ↓ StoryboardShot{image_path} + GenerationJob{status}
[8] 分镜视频生成（视频 API 插槽）
      ↓ StoryboardShot{video_path} + GenerationJob{status}
[9] 视频剪辑
      ↓ Timeline{clips, subtitles, bgm, transitions}
[10] FFmpeg 导出
      ↓ 输出 mp4 文件
```

### 各阶段详细数据字段

#### 阶段 1：项目创建

**输入**
```json
{
  "name": "偏偏宠你入骨",
  "type": "short_drama",
  "genre_tags": ["霸道总裁", "甜宠"],
  "audience": "女频",
  "tone": "甜虐",
  "ending": "HE",
  "total_episodes": 60,
  "aspect_ratio": "9:16"
}
```

**存储** → `projects` 表（扩展字段）

---

#### 阶段 2：剧本生成（现有）

**输入**：logline / novel_excerpt  
**输出**：SSE 流式 `delta` → 存入 `scripts.content`  
**现有流水线阶段**：digest → characters → adapt_outline → episode_scripts → storyboard → edit_script

---

#### 阶段 3：集数规划

**输入**：script.content + total_episodes + genre_tags  
**LLM 输出 JSON**：
```json
[
  {
    "episode_no": 1,
    "title": "命中注定的相遇",
    "act": "起势段",
    "hook_type": "悬念钩",
    "beat_summary": "苏念甜品店被砸，陆司寒误以为是黑道纠纷出手相救",
    "emotion_curve": "平→惊→暖",
    "paywall": false,
    "key_scenes": ["甜品店", "停车场对峙"]
  }
]
```

**存储** → `episodes` 表

---

#### 阶段 4 & 5：人物卡 + 三视图

**人物卡 JSON**（LLM 输出，存入 `characters.character_card_json`）：
```json
{
  "name": "苏念",
  "age": 26,
  "identity": "甜品店主",
  "personality": ["温柔坚韧", "轻度自卑"],
  "core_drive": "守护亡母留下的甜品店",
  "arc": "自卑少女 → 敢于被爱的独立女性",
  "catchphrase": "这家店就是我妈留给我的全部",
  "villain_layer": null,
  "appearance": "26岁东亚女性，长直发，眼神温柔，身材纤细"
}
```

**三视图提示词**（LLM 生成，存入 `characters` 表扩展字段）：
```json
{
  "triview_prompt_front": "26-year-old East Asian woman, slim figure, straight black hair, warm eyes, white apron, standing front view, studio lighting, full body, 9:16",
  "triview_prompt_side":  "same character, side profile view, ...",
  "triview_prompt_back":  "same character, back view, ..."
}
```

**图片生成调用**：三视图提示词 → 图片 Provider 插槽 → `triview_image_front/side/back`

---

#### 阶段 6：分镜生成

**LLM 输出 JSON**（存入 `storyboard_shots` 表）：
```json
{
  "shots": [
    {
      "shot_number": 1,
      "scene": "甜品店内·日",
      "shot_type": "全景",
      "camera_movement": "缓慢推进",
      "action": "苏念弯腰将柠檬挞摆入柜台",
      "dialogue": "今天这批酸度刚好，老陈头肯定又要买三个。",
      "narration": "这家甜品店是苏念与世界之间最后的温柔结界。",
      "duration_sec": 4.0,
      "ai_prompt": "26-year-old East Asian woman, white apron, bending over glass counter, placing lemon tart, warm yellow bakery interior, full shot, natural light, 9:16 vertical",
      "animation_prompt": "camera slowly push in, character moves gracefully, warm ambient light, gentle music",
      "ref_character_ids": [1],
      "ref_scene_ids": [1]
    }
  ]
}
```

---

#### 阶段 7：图片生成

**GenerationJob 记录**：
```json
{
  "job_type": "image",
  "provider_id": "dashscope_wanx",
  "ref_id": 42,
  "ref_type": "storyboard_shot",
  "prompt": "...",
  "status": "done",
  "result_path": "assets/proj_1/images/shot_42.png",
  "error": null,
  "created_at": "...",
  "finished_at": "..."
}
```

---

#### 阶段 8：视频生成

**GenerationJob 记录**（`job_type: "video"`）：
- 输入：`animation_prompt` + `image_path`（参考帧）+ `duration_sec`
- 输出：`video_path`（本地 mp4/webm）

---

#### 阶段 9 & 10：剪辑 + 导出

**Timeline JSON**（存入 `timelines` 表）：
```json
{
  "clips": [
    {
      "order": 1,
      "shot_id": 42,
      "clip_path": "assets/proj_1/videos/shot_42.mp4",
      "in_point": 0.0,
      "out_point": 4.0,
      "transition": "dissolve",
      "transition_duration": 0.5
    }
  ],
  "subtitles": [
    {
      "start": 0.0,
      "end": 3.5,
      "text": "今天这批酸度刚好，老陈头肯定又要买三个。",
      "style": "bottom_center"
    }
  ],
  "bgm": [
    {
      "path": "assets/bgm/gentle_piano.mp3",
      "start": 0.0,
      "end": 120.0,
      "volume": 0.3,
      "fade_in": 1.0,
      "fade_out": 2.0
    }
  ]
}
```

---

## 5. 图片生成 API 插槽设计

### 设计思路

参考现有 `providers.yaml`（LLM 插槽），新建 `media_providers.yaml`，图片 Provider 统一通过抽象基类调用。

### media_providers.example.yaml

```yaml
image_providers:
  - id: dashscope_wanx
    label: 阿里云通义万象（Wanx）
    type: dashscope_wanx
    api_key_env: DASHSCOPE_API_KEY
    model: wanx2.1-t2i-turbo
    default_size: "1024*1792"   # 9:16 竖屏
    extra: {}

  - id: volcengine_doubao_img
    label: 火山豆包图片
    type: volcengine_image
    api_key_env: VOLCENGINE_API_KEY
    access_key_env: VOLCENGINE_ACCESS_KEY
    model: high_aes_general_v21_L
    default_size: "1024x1792"
    extra: {}

  - id: kling_image
    label: 可灵图片
    type: kling_image
    api_key_env: KLING_API_KEY
    model: kling-v1
    default_size: "1024x1792"
    extra:
      image_fidelity: 0.5

  - id: comfyui_local
    label: 本地 ComfyUI
    type: comfyui
    base_url: http://127.0.0.1:8188
    workflow_path: "config/comfyui_workflows/sdxl_portrait.json"
    prompt_node_id: "6"
    default_size: "1024x1792"
    extra: {}

  - id: openai_dalle3
    label: OpenAI DALL·E 3
    type: openai_dalle
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY
    model: dall-e-3
    default_size: "1024x1792"
    extra:
      quality: standard
      style: vivid
```

### 抽象基类（`backend/app/providers/base.py`）

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

@dataclass
class ImageRequest:
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1792
    ref_image_paths: list[str] = None   # 参考图（人物一致性）
    seed: Optional[int] = None
    steps: int = 30

@dataclass
class ImageResult:
    image_url: Optional[str] = None     # 远程 URL（需下载）
    local_path: Optional[str] = None    # 已保存本地路径
    raw_response: dict = None

class AbstractImageProvider(ABC):
    def __init__(self, config: dict): ...

    @abstractmethod
    async def generate(self, req: ImageRequest) -> ImageResult: ...

    @abstractmethod
    def is_available(self) -> bool: ...
```

### Provider 注册与调度（`backend/app/providers/__init__.py`）

```python
from .image.dashscope import DashScopeWanxProvider
from .image.volcengine import VolcengineImageProvider
from .image.kling_image import KlingImageProvider
from .image.comfyui import ComfyUIProvider
from .image.openai_dalle import OpenAIDalleProvider

IMAGE_PROVIDER_MAP = {
    "dashscope_wanx":    DashScopeWanxProvider,
    "volcengine_image":  VolcengineImageProvider,
    "kling_image":       KlingImageProvider,
    "comfyui":           ComfyUIProvider,
    "openai_dalle":      OpenAIDalleProvider,
}

def get_image_provider(provider_id: str) -> AbstractImageProvider:
    """从 media_providers.yaml 加载配置，实例化对应 Provider。"""
    ...
```

### 关键实现要点

1. **参考图传递**：`ref_image_paths` 支持传入角色三视图，实现人物一致性（类似 LocalMiniDrama 的参考图机制）。
2. **异步调度**：生成任务进入 `generation_jobs` 表，后台 `asyncio.Task` 轮询/回调更新状态。
3. **本地缓存**：URL 结果自动下载到 `assets/proj_{id}/images/` 目录。
4. **重试机制**：429/超时自动重试 3 次，指数退避。

---

## 6. 视频生成 API 插槽设计

### media_providers.yaml（视频部分）

```yaml
video_providers:
  - id: kling_video
    label: 可灵视频（标准）
    type: kling_video
    api_key_env: KLING_API_KEY
    model: kling-v1-5
    default_duration: 5        # 秒
    default_mode: std
    extra: {}

  - id: kling_omni
    label: 可灵 Omni（多图参考）
    type: kling_video
    api_key_env: KLING_API_KEY
    model: kling-v1-omni
    default_duration: 5
    default_mode: pro
    extra:
      omni_mode: true

  - id: volcengine_seedance
    label: 火山 Seedance 1.0
    type: volcengine_video
    api_key_env: VOLCENGINE_API_KEY
    access_key_env: VOLCENGINE_ACCESS_KEY
    model: doubao-seedance-1-0
    default_duration: 5
    extra: {}

  - id: volcengine_seedance2
    label: 火山 Seedance 2.0（多图）
    type: volcengine_video
    api_key_env: VOLCENGINE_API_KEY
    access_key_env: VOLCENGINE_ACCESS_KEY
    model: doubao-seedance-2-0-260128
    default_duration: 5
    extra:
      omni_mode: true           # 多参考图模式

  - id: dashscope_wan
    label: 通义万相视频（Wan2.1）
    type: dashscope_video
    api_key_env: DASHSCOPE_API_KEY
    model: wan2.1-t2v-turbo
    default_duration: 5
    extra: {}

  - id: vidu_v2
    label: Vidu 生数 v2
    type: vidu_video
    api_key_env: VIDU_API_KEY
    model: vidu2.0
    default_duration: 4
    extra: {}

  - id: cogvideox_api
    label: CogVideoX（API）
    type: cogvideox_video
    base_url: https://open.bigmodel.cn/api/paas/v4
    api_key_env: ZHIPU_API_KEY
    model: cogvideox-2
    default_duration: 5
    extra: {}
```

### 抽象基类（视频）

```python
@dataclass
class VideoRequest:
    prompt: str                         # 视频动画描述
    image_path: Optional[str] = None   # 首帧参考图（图生视频）
    ref_image_paths: list[str] = None  # 多图参考（Omni 模式）
    duration_sec: float = 5.0
    width: int = 1024
    height: int = 1792                 # 9:16
    seed: Optional[int] = None

@dataclass
class VideoResult:
    task_id: Optional[str] = None      # 异步任务 ID（部分 provider 为异步）
    video_url: Optional[str] = None    # 完成后的下载 URL
    local_path: Optional[str] = None
    status: str = "pending"            # pending / processing / done / failed
    raw_response: dict = None

class AbstractVideoProvider(ABC):
    @abstractmethod
    async def submit(self, req: VideoRequest) -> VideoResult: ...

    @abstractmethod
    async def poll(self, task_id: str) -> VideoResult: ...
```

### 异步轮询调度器（`backend/app/providers/video_poller.py`）

视频生成通常为异步 API（提交 → 轮询 → 回调）：

```
提交任务 → GenerationJob{status: "running", provider_task_id: "xxx"}
    ↓  后台 asyncio 定时器（5s 轮询）
轮询完成 → 下载视频 → GenerationJob{status: "done", result_path: "..."}
    ↓  WebSocket / SSE 推送前端更新
```

---

## 7. 视频剪辑模块设计

### 架构分层

```
前端 VideoEditorTab（React）
    ↕ REST API
后端 editor.py Router
    ↕
Timeline 数据层（SQLite timelines / subtitle_tracks / bgm_tracks 表）
    ↕
FFmpeg Export Engine（ffmpeg_export.py）
```

### 时间线数据结构

#### `timelines` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | int PK | |
| project_id | int FK | |
| episode_id | int FK | 对应第几集 |
| total_duration | float | 合计时长（秒） |
| aspect_ratio | str | "9:16" |
| fps | int | 24 或 30 |
| clips_json | text | JSON 数组（ClipItem[]） |
| subtitles_json | text | JSON 数组（SubtitleItem[]） |
| bgm_json | text | JSON 数组（BgmTrack[]） |
| transitions_json | text | JSON 数组（Transition[]） |
| export_path | str | 导出的 mp4 路径 |
| status | str | draft/exporting/done |
| created_at | datetime | |
| updated_at | datetime | |

#### ClipItem JSON Schema

```json
{
  "order": 1,
  "shot_id": 42,
  "clip_path": "assets/proj_1/videos/shot_42.mp4",
  "in_point": 0.0,
  "out_point": 4.0,
  "speed": 1.0,
  "volume": 1.0,
  "color_grade": "warm",
  "transition_in": {
    "type": "dissolve",
    "duration": 0.5
  }
}
```

#### SubtitleItem JSON Schema

```json
{
  "id": 1,
  "start": 0.0,
  "end": 3.5,
  "text": "今天这批酸度刚好",
  "speaker": "苏念",
  "type": "dialogue",
  "style": {
    "font_size": 38,
    "color": "#FFFFFF",
    "shadow": true,
    "position": "bottom_center",
    "margin_bottom": 80
  }
}
```

#### BgmTrack JSON Schema

```json
{
  "id": 1,
  "path": "assets/bgm/gentle_piano.mp3",
  "start_at_video": 0.0,
  "end_at_video": 120.0,
  "volume": 0.25,
  "fade_in_sec": 2.0,
  "fade_out_sec": 3.0,
  "loop": true
}
```

### FFmpeg 导出流程（`backend/app/editor/ffmpeg_export.py`）

```python
async def export_timeline(timeline: Timeline, output_path: str) -> None:
    """
    1. concat_clips()  → 按 ClipItem 顺序拼接视频，加转场滤镜
    2. overlay_subtitles() → drawtext/subtitles 滤镜嵌入字幕
    3. mix_bgm()       → amix 混合背景音乐，调整音量
    4. final_encode()  → libx264 + aac，输出 mp4
    """
```

**关键 FFmpeg 命令模式**：

```bash
# 步骤1：concat + 转场（xfade 滤镜）
ffmpeg -i clip1.mp4 -i clip2.mp4 \
  -filter_complex "[0][1]xfade=transition=dissolve:duration=0.5:offset=3.5[v]" \
  -map "[v]" -c:v libx264 concat_out.mp4

# 步骤2：字幕
ffmpeg -i concat_out.mp4 \
  -vf "subtitles=subs.ass:force_style='FontSize=38'" \
  with_subs.mp4

# 步骤3：BGM 混音
ffmpeg -i with_subs.mp4 -i bgm.mp3 \
  -filter_complex "[1:a]volume=0.25,afade=t=in:d=2,afade=t=out:st=118:d=3[bgm];[0:a][bgm]amix=inputs=2:duration=first[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac final.mp4
```

### 前端 VideoEditorTab 功能

| 功能区 | 说明 |
|--------|------|
| **时间线轨道** | 视频轨（可拖拽排序）+ 字幕轨 + BGM 轨，可视化时间轴 |
| **镜头库** | 左侧面板展示所有已生成视频的 shot，拖拽加入时间线 |
| **字幕编辑** | 点击字幕条目编辑文本/时间/样式；支持从对白/旁白自动导入 |
| **BGM 管理** | 上传/选择 BGM 文件，调整音量/淡入淡出 |
| **转场设置** | 点击两个 clip 之间设置转场类型（淡入淡出/溶解/无） |
| **预览** | 调用后端接口生成预览片段（低分辨率快速导出） |
| **导出** | 触发全分辨率 FFmpeg 导出，SSE 进度反馈 |

---

## 8. 数据库表设计（增量）

> 基于现有 6 张表扩展，采用 `ALTER TABLE` 或新表方式。

### 8.1 扩展 `projects` 表

```sql
ALTER TABLE projects ADD COLUMN genre_tags TEXT DEFAULT '[]';      -- JSON 数组
ALTER TABLE projects ADD COLUMN audience TEXT DEFAULT '';           -- 女频/男频/全龄
ALTER TABLE projects ADD COLUMN tone TEXT DEFAULT '';               -- 甜/虐/甜虐/爽/燃
ALTER TABLE projects ADD COLUMN ending TEXT DEFAULT 'HE';          -- HE/BE/OE
ALTER TABLE projects ADD COLUMN total_episodes INT DEFAULT 0;
ALTER TABLE projects ADD COLUMN aspect_ratio TEXT DEFAULT '9:16';
```

### 8.2 扩展 `characters` 表

```sql
ALTER TABLE characters ADD COLUMN character_card_json TEXT DEFAULT '{}';  -- 完整人物卡
ALTER TABLE characters ADD COLUMN triview_prompt_front TEXT DEFAULT '';
ALTER TABLE characters ADD COLUMN triview_prompt_side TEXT DEFAULT '';
ALTER TABLE characters ADD COLUMN triview_prompt_back TEXT DEFAULT '';
ALTER TABLE characters ADD COLUMN triview_image_front TEXT;
ALTER TABLE characters ADD COLUMN triview_image_side TEXT;
ALTER TABLE characters ADD COLUMN triview_image_back TEXT;
```

### 8.3 扩展 `storyboard_shots` 表

```sql
ALTER TABLE storyboard_shots ADD COLUMN episode_id INT;
ALTER TABLE storyboard_shots ADD COLUMN narration TEXT DEFAULT '';        -- 旁白（与 dialogue 分离）
ALTER TABLE storyboard_shots ADD COLUMN ref_character_ids TEXT DEFAULT '[]';  -- JSON int[]
ALTER TABLE storyboard_shots ADD COLUMN ref_scene_ids TEXT DEFAULT '[]';
ALTER TABLE storyboard_shots ADD COLUMN lighting TEXT DEFAULT '';
ALTER TABLE storyboard_shots ADD COLUMN depth_of_field TEXT DEFAULT '';
ALTER TABLE storyboard_shots ADD COLUMN color_palette TEXT DEFAULT '';
ALTER TABLE storyboard_shots ADD COLUMN universal_segment_text TEXT DEFAULT '';  -- 全能模式
```

### 8.4 新增 `episodes` 表

```sql
CREATE TABLE episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  episode_no      INTEGER NOT NULL,
  title           TEXT DEFAULT '',
  act             TEXT DEFAULT '',          -- 起势段/攀升段/风暴段/决战段
  hook_type       TEXT DEFAULT '',          -- 悬念钩/情绪钩/反转钩/信息钩/危机钩
  beat_summary    TEXT DEFAULT '',
  emotion_curve   TEXT DEFAULT '',
  paywall         BOOLEAN DEFAULT 0,
  key_scenes      TEXT DEFAULT '[]',
  script_content  TEXT DEFAULT '',          -- 该集完整剧本
  status          TEXT DEFAULT 'pending',   -- pending/generating/done
  created_at      DATETIME,
  updated_at      DATETIME
);
```

### 8.5 新增 `generation_jobs` 表

```sql
CREATE TABLE generation_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  job_type         TEXT NOT NULL,           -- image / video / triview
  provider_id      TEXT NOT NULL,
  ref_id           INTEGER,                 -- shot_id 或 character_id
  ref_type         TEXT,                    -- storyboard_shot / character
  prompt           TEXT DEFAULT '',
  negative_prompt  TEXT DEFAULT '',
  provider_task_id TEXT,                    -- 异步 API 返回的任务 ID
  status           TEXT DEFAULT 'pending',  -- pending/running/done/failed
  result_path      TEXT,
  error            TEXT,
  retry_count      INTEGER DEFAULT 0,
  created_at       DATETIME,
  finished_at      DATETIME
);
```

### 8.6 新增 `timelines` 表

```sql
CREATE TABLE timelines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  episode_id       INTEGER REFERENCES episodes(id),
  total_duration   REAL DEFAULT 0.0,
  aspect_ratio     TEXT DEFAULT '9:16',
  fps              INTEGER DEFAULT 24,
  clips_json       TEXT DEFAULT '[]',
  subtitles_json   TEXT DEFAULT '[]',
  bgm_json         TEXT DEFAULT '[]',
  transitions_json TEXT DEFAULT '[]',
  export_path      TEXT,
  status           TEXT DEFAULT 'draft',    -- draft/exporting/done
  created_at       DATETIME,
  updated_at       DATETIME
);
```

---

## 9. 后端 Router 清单

### 现有 Router（保持不变，部分扩展）

| Router | 前缀 | 说明 |
|--------|------|------|
| projects.py | `/api/projects` | 扩展：支持 genre_tags 等新字段 |
| scripts.py | `/api/projects/{id}/scripts` | 不变 |
| characters.py | `/api/projects/{id}/characters` | 扩展：三视图生成接口 |
| storyboard.py | `/api/projects/{id}/scenes` | 扩展：批量生成触发 |
| assets.py | `/api/projects/{id}/assets` | 不变 |
| settings.py | `/api/settings` | 扩展：媒体 Provider 配置 |
| download.py | `/api/download` | 不变 |
| memory.py | `/api/memory` | 不变 |

### 新增 Router

#### `episodes.py` — 集数规划

```
GET    /api/projects/{id}/episodes              # 列出所有集数
POST   /api/projects/{id}/episodes              # 手动新建集数
PATCH  /api/projects/{id}/episodes/{ep_id}      # 编辑集数信息
DELETE /api/projects/{id}/episodes/{ep_id}      # 删除集数
POST   /api/projects/{id}/episodes/generate     # LLM 批量生成集数规划（SSE）
POST   /api/projects/{id}/episodes/{ep_id}/script  # 生成该集完整剧本
```

#### `generation.py` — 图片/视频生成

```
GET    /api/projects/{id}/jobs                        # 列出所有生成任务
POST   /api/projects/{id}/jobs/image                  # 提交图片生成任务
POST   /api/projects/{id}/jobs/video                  # 提交视频生成任务
POST   /api/projects/{id}/jobs/triview/{char_id}      # 提交三视图生成
POST   /api/projects/{id}/jobs/batch-image            # 批量图片生成（所有分镜）
POST   /api/projects/{id}/jobs/batch-video            # 批量视频生成（所有分镜）
GET    /api/projects/{id}/jobs/{job_id}               # 查询单个任务状态
DELETE /api/projects/{id}/jobs/{job_id}               # 取消任务
GET    /api/media-providers                           # 列出可用图片/视频 Provider
```

#### `editor.py` — 视频剪辑

```
GET    /api/projects/{id}/timelines                   # 列出时间线
POST   /api/projects/{id}/timelines                   # 新建时间线
GET    /api/projects/{id}/timelines/{tl_id}           # 获取时间线详情（含 clips/subs/bgm JSON）
PATCH  /api/projects/{id}/timelines/{tl_id}           # 更新时间线（局部修改）
POST   /api/projects/{id}/timelines/{tl_id}/auto-import  # 从分镜自动导入 clip 列表
POST   /api/projects/{id}/timelines/{tl_id}/export    # 触发 FFmpeg 导出（SSE 进度）
GET    /api/projects/{id}/timelines/{tl_id}/preview   # 生成低分辨率预览
POST   /api/projects/{id}/timelines/{tl_id}/subtitles/import-from-shots  # 从分镜对白/旁白导入字幕
```

---

## 10. 前端页面/Tab 规划

### ProjectManager 页面（现有，微调）

- 新增项目卡片展示 `genre_tags`、`total_episodes`
- 新建项目弹窗增加：题材多选、集数、画面比例

### ProjectWorkspace Tab 列表（扩展）

| Tab ID | 标签 | 状态 | 说明 |
|--------|------|------|------|
| `script` | 剧本 | 现有 | 保持现有，加集数生成按钮 |
| `episodes` | 集数规划 | **新增** | 集数列表、钩子类型、状态、逐集生成 |
| `characters` | 角色 | 现有扩展 | 新增三视图生成UI |
| `storyboard` | 分镜 | 现有扩展 | 新增批量生成图片/视频按钮 |
| `generation` | 生成监控 | **新增** | 图片/视频生成任务队列面板 |
| `editor` | 视频剪辑 | **新增** | 时间线编辑器 |
| `edit` | 剪辑脚本 | 现有 | 保持现有（文字剪辑脚本） |
| `assets` | 素材库 | 现有 | 保持现有 |

### 各新增 Tab 核心 UI 组件

#### EpisodesTab

```
┌─────────────────────────────────────────────────────────┐
│ [生成集数规划] [新建集数]                              │
├────┬──────────────┬────────┬────────┬────────┬──────────┤
│ 集 │ 标题         │ 幕段   │ 钩子   │ 付费墙 │ 状态     │
├────┼──────────────┼────────┼────────┼────────┼──────────┤
│ 1  │ 命中注定的相遇│ 起势段 │ 悬念钩 │ ○      │ ✓ done  │
│ 2  │ 意外的同居   │ 起势段 │ 情绪钩 │ ○      │ ⏳ 生成中│
└────┴──────────────┴────────┴────────┴────────┴──────────┘
点击行 → 右侧展开详情编辑器 + [生成本集剧本]
```

#### GenerationTab

```
┌─────────────────────────────────────────────────────────┐
│ 图片 Provider: [dashscope_wanx ▼]  [批量生成图片]       │
│ 视频 Provider: [kling_video ▼]     [批量生成视频]       │
├─────────────────────────────────────────────────────────┤
│ 任务队列                                                 │
│ ◎ 运行中 (3)  ✓ 完成 (12)  ✗ 失败 (1)                  │
│ ┌─────┬──────────────┬──────────┬──────────┬──────────┐ │
│ │ ID  │ 类型         │ 目标     │ 状态     │ 操作     │ │
│ ├─────┼──────────────┼──────────┼──────────┼──────────┤ │
│ │ 45  │ 🖼 图片      │ Shot #5  │ ◎ 生成中 │ [取消]   │ │
│ │ 44  │ 🎬 视频      │ Shot #4  │ ✓ 完成   │ [查看]   │ │
│ │ 43  │ 🧍 三视图    │ 苏念     │ ✗ 失败   │ [重试]   │ │
│ └─────┴──────────────┴──────────┴──────────┴──────────┘ │
└─────────────────────────────────────────────────────────┘
```

#### VideoEditorTab

```
┌──────────────────────────────────────────────────────────────┐
│  [自动导入分镜] [预览] [导出 MP4]        总时长: 02:15        │
├────────────┬─────────────────────────────────────────────────┤
│ 镜头库     │                时间线                           │
│ ┌────────┐ │  视频轨 ▓▓▓│░░░│▓▓▓▓│░░│▓▓▓▓▓│                │
│ │Shot #1 │ │  字幕轨 ════════════════════════════            │
│ │[缩略图]│ │  BGM轨  ─────────────────────────              │
│ │Shot #2 │ │                                                  │
│ │[缩略图]│ │  时间轴 0s    10s    20s    30s ...             │
│ └────────┘ │                                                  │
└────────────┴─────────────────────────────────────────────────┘
```

---

## 11. 新增/修改文件清单

### 后端新增文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `backend/app/providers/__init__.py` | P0 | Provider 注册表 |
| `backend/app/providers/base.py` | P0 | 抽象基类 ImageRequest/VideoRequest |
| `backend/app/providers/loader.py` | P0 | 从 YAML 加载并实例化 Provider |
| `backend/app/providers/image/dashscope.py` | P0 | 阿里云 Wanx |
| `backend/app/providers/image/volcengine.py` | P1 | 火山豆包图片 |
| `backend/app/providers/image/kling_image.py` | P1 | 可灵图片 |
| `backend/app/providers/image/comfyui.py` | P2 | 本地 ComfyUI |
| `backend/app/providers/image/openai_dalle.py` | P2 | DALL·E 3 |
| `backend/app/providers/video/kling.py` | P0 | 可灵视频 |
| `backend/app/providers/video/volcengine.py` | P0 | 火山 Seedance |
| `backend/app/providers/video/dashscope.py` | P1 | 通义万相视频 |
| `backend/app/providers/video/vidu.py` | P2 | Vidu |
| `backend/app/providers/video/cogvideox.py` | P2 | CogVideoX |
| `backend/app/providers/video_poller.py` | P0 | 异步轮询调度器 |
| `backend/app/routers/episodes.py` | P0 | 集数规划 CRUD + LLM 生成 |
| `backend/app/routers/generation.py` | P0 | 图片/视频生成调度 |
| `backend/app/routers/editor.py` | P1 | 视频剪辑时间线 |
| `backend/app/editor/__init__.py` | P1 | |
| `backend/app/editor/timeline.py` | P1 | 时间线组装 |
| `backend/app/editor/subtitle.py` | P1 | 字幕生成（SRT/ASS） |
| `backend/app/editor/ffmpeg_export.py` | P1 | FFmpeg 封装 |
| `backend/app/pipelines/episode_planner.py` | P0 | 集数规划流水线 |
| `backend/app/prompts/character_triview.md` | P0 | 三视图提示词 |
| `backend/app/prompts/episode_planner.md` | P0 | 集数规划提示词 |
| `backend/config/media_providers.example.yaml` | P0 | 媒体 Provider 配置模板 |

### 后端修改文件

| 文件 | 修改内容 |
|------|----------|
| `backend/app/db/models.py` | 新增 Episode / GenerationJob / Timeline 表；扩展现有表字段 |
| `backend/app/main.py` | 注册新 Router（episodes, generation, editor） |
| `backend/app/routers/characters.py` | 新增 `POST /{char_id}/triview` 生成三视图提示词 + 调用图片 API |
| `backend/app/routers/storyboard.py` | 新增批量生成触发接口 |
| `backend/app/routers/settings.py` | 支持读写 `media_providers.yaml` |
| `backend/requirements.txt` | 新增：`httpx` `aiofiles` `ffmpeg-python` |

### 前端新增文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `renderer/src/tabs/EpisodesTab.tsx` | P0 | 集数规划 Tab |
| `renderer/src/tabs/GenerationTab.tsx` | P0 | 生成监控面板 |
| `renderer/src/tabs/VideoEditorTab.tsx` | P1 | 视频剪辑时间线 |
| `renderer/src/hooks/useGenerationJobs.ts` | P0 | 生成任务轮询 Hook |
| `renderer/src/hooks/useTimeline.ts` | P1 | 时间线状态管理 Hook |
| `renderer/src/components/ProviderSelect.tsx` | P0 | Provider 下拉选择器 |
| `renderer/src/components/TimelineTrack.tsx` | P1 | 时间线轨道组件 |
| `renderer/src/components/SubtitleEditor.tsx` | P1 | 字幕编辑组件 |

### 前端修改文件

| 文件 | 修改内容 |
|------|----------|
| `renderer/src/pages/ProjectWorkspace.tsx` | 增加 EpisodesTab / GenerationTab / VideoEditorTab；扩展 TabId 类型 |
| `renderer/src/tabs/CharactersTab.tsx` | 新增三视图生成按钮和图片预览区 |
| `renderer/src/tabs/StoryboardTab.tsx` | 新增批量生成图片/视频按钮；显示生成状态角标 |
| `renderer/src/pages/ProjectManager.tsx` | 新建项目弹窗增加 genre_tags、total_episodes 字段 |

---

## 12. 实施优先级：MVP vs 完善版

### Phase 0：基础设施（1-2天）

> 目标：Provider 抽象层跑通，能调用至少一家图片和视频 API

- [ ] 新建 `media_providers.example.yaml`
- [ ] 实现 `providers/base.py`（抽象类）
- [ ] 实现 `providers/loader.py`（YAML → 实例）
- [ ] 实现 `providers/image/dashscope.py`（阿里云 Wanx，较简单）
- [ ] 实现 `providers/video/kling.py`（可灵，有完善 API 文档）
- [ ] 实现 `providers/video_poller.py`（异步轮询）
- [ ] 扩展 `db/models.py`（GenerationJob 表）
- [ ] 实现 `routers/generation.py`（提交/查询任务）
- [ ] `settings.py` 支持 media_providers 读写

### Phase 1：集数规划 + 人物三视图（2-3天）

> 目标：完整的剧本→集数→人物卡→三视图流程跑通

- [ ] 新建 `prompts/episode_planner.md`（集数规划提示词）
- [ ] 新建 `prompts/character_triview.md`（三视图提示词）
- [ ] 实现 `routers/episodes.py` + `Episode` 表
- [ ] 扩展 `characters` 表（triview 字段）
- [ ] 扩展 `characters.py` Router（三视图生成接口）
- [ ] 前端：`EpisodesTab.tsx`
- [ ] 前端：`CharactersTab.tsx` 扩展三视图 UI
- [ ] 前端：`GenerationTab.tsx`（基础版：任务列表）

### Phase 2：分镜图片/视频批量生成（2-3天）

> 目标：一键生成所有分镜的图片和视频

- [ ] 扩展 `storyboard_shots` 表（narration / ref_ids 等字段）
- [ ] `routers/generation.py` 支持 `batch-image` / `batch-video`
- [ ] 实现图片生成并发队列（3路并发，参考 LocalMiniDrama）
- [ ] 实现视频生成并发队列 + 轮询
- [ ] `StoryboardTab.tsx` 扩展：批量生成按钮 + 状态角标
- [ ] 分镜图片参考图传递（角色三视图 → ref_image_paths）

### Phase 3：视频剪辑 + 导出（3-4天）

> 目标：时间线编辑器 + FFmpeg 导出成片

- [ ] 新建 `timelines` 表
- [ ] 实现 `routers/editor.py`（时间线 CRUD + 自动导入）
- [ ] 实现 `editor/timeline.py`（时间线组装逻辑）
- [ ] 实现 `editor/subtitle.py`（从分镜导白/旁白自动生成 SRT）
- [ ] 实现 `editor/ffmpeg_export.py`（FFmpeg 封装，SSE 进度）
- [ ] 前端：`VideoEditorTab.tsx`（时间线 + 字幕 + BGM）
- [ ] Electron 打包时内置 FFmpeg 可执行文件

### Phase 4：完善与扩展（持续）

- [ ] 更多图片 Provider（ComfyUI、Volcengine、Midjourney 代理）
- [ ] 更多视频 Provider（Vidu、CogVideoX、Wan2.1、Sora）
- [ ] 项目导出/导入（ZIP 包，参考 LocalMiniDrama）
- [ ] 合规审查（参考 short-drama compliance 模块）
- [ ] 海外模式（English + Hollywood format）
- [ ] TTS 字幕配音
- [ ] 分镜四宫格模式
- [ ] 工程版本历史记录

---

## 13. 参考仓库关键借鉴点

### LocalMiniDrama（Vue3 + Node.js + SQLite）

| 借鉴点 | 如何应用 |
|--------|----------|
| **完整 8 步流程**（故事→剧本→角色→场景→道具→分镜→图片→合成） | 对照补全现有流程中缺失的 场景/道具 管理 |
| **三类独立配置**（文字/图片/视频 Provider 独立） | 现有只有 LLM Provider，需新增 media_providers.yaml |
| **图片参考图传递机制**（角色图 → 分镜参考图 → 视频参考帧） | 在 `ImageRequest.ref_image_paths` 中实现，`ref_character_ids` 字段自动解析 |
| **全能模式**（多图参考 + `@图片N` 语法） | `universal_segment_text` + `kling_omni` / `seedance2` Provider |
| **AI 并发生成**（图片/视频各 3 路并发） | `generation.py` 中使用 `asyncio.Semaphore(3)` 限制并发 |
| **失败重试 3 次** | `generation_jobs.retry_count` + 指数退避 |
| **SRT 字幕导出**（narration 旁白字段） | `storyboard_shots.narration` 已规划，`subtitle.py` 实现 SRT 生成 |
| **视频历史版本**（主视频选择持久化） | 可扩展 `generation_jobs` 存多次生成结果 |

### ai-screenplay-writer（LangGraph 多 Agent）

| 借鉴点 | 如何应用 |
|--------|----------|
| **多 Agent 角色分工**（编剧/制片人/编辑） | 现有流水线基于顺序 SSE，可升级为 LangGraph 状态机（Phase 4） |
| **全季剧本连续性**（多集共用角色记忆） | `memory_manager.py` 已存在，需加入 Episode 级记忆隔离 |
| **图结构写作室**（graph-based writers' room） | 未来可将 `episode_planner` 改造为 LangGraph 节点图 |

### short-drama（短剧 Skill 知识库）

| 借鉴点 | 如何应用 |
|--------|----------|
| **13 种题材模板** | 在 `projects.genre_tags` 选项和 `episode_planner.md` 提示词中内置 |
| **四层反派体系** | 写入 `character_analyzer.md` 扩展内容 |
| **五种钩子类型** | `episodes.hook_type` 字段枚举值；`episode_planner.md` 中要求 LLM 标注 |
| **节奏曲线四段式** | 集数规划时 `episodes.act` 字段（起势段/攀升段/风暴段/决战段）+ 比例约束 |
| **付费卡点设计** | `episodes.paywall` 布尔字段；`episode_planner.md` 要求 10-15% 设为付费卡点 |
| **爽感矩阵** | 注入 `episode_writer.md` 提示词，要求输出爽感要素密度标注 |
| **合规审查清单** | 新增 `compliance_check.md` 提示词，`episodes.py` 提供 `/compliance` 接口 |
| **状态文件机制**（`.drama-state.json`） | 对应现有 `Project` 表 + `Episode` 表状态字段 |

---

## 附录 A：三视图提示词模板

```markdown
# 人物三视图提示词生成系统

## 任务
根据人物档案，生成三个方位（正面/侧面/背面）的一致性图片生成提示词，
用于图片生成 API 生成参考图，确保角色外貌在所有后续分镜中保持一致。

## 输入
- 人物姓名：{name}
- 人物外貌描述：{appearance}
- 人物身份与服装风格：{identity_style}
- 画面比例：{aspect_ratio}

## 输出格式（JSON）
{
  "front": "英文图片提示词（正面，全身，中性表情，白色背景或纯色背景，参考图风格）",
  "side":  "英文图片提示词（90度侧面，全身）",
  "back":  "英文图片提示词（背面，全身）"
}

## 提示词规范
1. 必须包含：年龄范围、人种外貌特征、发型发色、服装描述、体型
2. 必须包含：full body, {aspect_ratio} vertical, character reference sheet
3. 必须包含：正面/侧面/背面方位词（front view / side profile / back view）
4. 避免：动态姿势、强烈情绪、复杂背景
5. 推荐结尾：clean background, concept art style, consistent lighting
```

---

## 附录 B：分镜生成提示词扩展（含旁白与参考图）

在现有 `storyboard_director.md` 基础上，补充以下要求：

```markdown
## 输出字段扩展
每个 shot 除现有字段外，新增：
- narration: 该镜头的旁白/解说文字（与 dialogue 分离，空字符串表示无旁白）
- ref_character_ids: 涉及的角色 ID 数组（与人物卡对应，用于自动关联参考图）
- ref_scene_ids: 涉及的场景 ID 数组
- lighting: 灯光描述（natural/warm/cold/dramatic/backlit）
- depth_of_field: 景深（shallow/deep）
- color_palette: 色调（warm/cool/neutral/golden/blue_teal）

## ai_prompt 构成规范
ai_prompt = [角色参考描述] + [场景环境] + [景别/镜头类型] + [动作] + [灯光/色调] + [技术参数]
示例："26-year-old East Asian woman, straight black hair, white apron [CHAR_REF:1], 
     warm bakery interior [SCENE_REF:1], full shot, bending over glass counter, 
     warm golden lighting, shallow depth of field, 9:16 vertical, cinematic"
```

---

*文档结束。下一步：按 Phase 0 启动实施，从 Provider 抽象层和 media_providers.yaml 开始。*
