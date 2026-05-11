/**
 * 角色板文生图模板（六大板块）— 须与后端 `backend/app/prompts/character_sheet_template.py` 中 BOARD_PROMPT_FIXED 保持一致。
 *
 * 板块：三视图 / 面部表情集 / 发型·头饰 / 服饰面料 / 随身物品 / 人物设定文字
 */
export const DEFAULT_CHARACTER_BOARD_PROMPT = `请根据本角色档案，生成一张高完成度的角色设定参考板（Character Design Sheet），风格类似专业游戏/影视官方设定集。

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
Optionally use bold graphic framing reminiscent of Persona 5 art-book pages for section labels.`;
