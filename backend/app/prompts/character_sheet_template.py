"""角色板文生图提示词模板 — 六大板块。

板块参照专业角色设定图（如「韩清商」式古风设定板）：
  1. 三视图      — 正面 / 侧面 / 背面全身立绘
  2. 面部表情集  — 6–8 种标准表情
  3. 发饰·头饰   — 发型 / 头冠 / 发簪细节特写
  4. 服饰面料    — 衣料纹理 / 配色色板 / 刺绣细节
  5. 随身物品    — 首饰 / 武器 / 道具等拆解图
  6. 人物设定    — 姓名 / 性格 / 身份 / 世界观概述

与前端 `renderer/src/lib/characterSheetTemplate.ts` 保持同步。
"""

BOARD_PROMPT_FIXED = """请根据本角色档案，生成一张高完成度的角色设定参考板（Character Design Sheet），风格类似专业游戏/影视官方设定集。

全图分为以下六个板块，统一白底/浅灰底，排版整洁有序，板块之间用细线或留白分隔：

【板块一：三视图】
正面、侧面、背面全身立绘水平排列，人物比例、服装、发型、配饰在三个视角完全一致。
Include three-view drawings: front, side, and back — proportions, clothing, hairstyle and accessories must be perfectly consistent across all views.

【板块二：面部表情集】
同一角色的 6–8 种标准表情半身头像（默认/微笑/生气/惊讶/悲伤/害羞/邪笑/沉思），五官与发型保持高度一致。
Add 6–8 facial expression variations: default, smile, angry, surprised, sad, shy, smirk, contemplative — face shape and hairstyle must remain highly consistent.

【板块三：发型·头饰特写】
发型结构拆解（正面与背面）、头冠/发簪/发带等头饰放大特写，标注关键造型元素。
Break down hairstyle structure (front & back views) and close-up details of headpieces, hairpins, ribbons with labeled key elements.

【板块四：服饰面料细节】
服装正面/背面全貌缩略 + 面料纹理/刺绣花样放大特写 + 配色色板（5–7 色块标注色名）。
Show full costume thumbnail (front & back) + fabric texture / embroidery close-ups + a color palette with 5–7 labeled color swatches.

【板块五：随身物品】
角色标志性配饰与道具的独立拆解图（首饰、武器、书卷、香囊、徽章等），每件标注名称与简要说明。
Display character's signature accessories and props as individual breakdown illustrations — jewelry, weapons, scrolls, pouches, badges — each labeled with name and brief note.

【板块六：人物设定文字区】
右上角或右侧留出文字栏，包含：角色姓名（大字）、性格特点（3–5 关键词）、身份背景（一句话）、核心经历、世界观简述。
Reserve a text column (top-right or right side) with: character name (large), personality keywords, identity, core arc, and worldview summary.

整体风格：High resolution, professional concept art style, organized layout, white/light gray background, illustration style.
Optionally use bold graphic framing reminiscent of Persona 5 art-book pages for section labels."""


def characters_phase_board_prompt_extra() -> str:
    """追加到 characters 阶段 system 提示：JSON 内 character_sheet_prompt 字段说明。"""
    return f"""

【角色板文生图提示词】每位角色必须增加字符串字段 "character_sheet_prompt"：内容是用户可直接复制到文生图模型（如 GPT-Image-2）的一条完整提示词，不要 JSON、不要字段名列表。
要求：
1. 必须以如下「固定框架」为主体（保留全部中文板块说明、英文翻译行、以及末行 High resolution...；可对个别措辞微调，但不得删除任一板块）：

{BOARD_PROMPT_FIXED}

2. 在「请根据本角色档案」之后、【板块一】之前，插入 2–4 句中文，写清本角色专属可视造型（年龄感/体型/发型与五官/服装配色与风格/时代背景），须与同一角色的 visual_prompt 一致或在其基础上展开。
3. 在各板块中文描述里，将泛称（如"角色标志性配饰"）替换为本角色的具体物品名称。
4. 仍须保留简短的 "visual_prompt" 字段（结构化造型要点，供其它环节浏览）；character_sheet_prompt 是面向出图的完整长文本。"""
