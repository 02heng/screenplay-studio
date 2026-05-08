"""院线长剧本：多阶段提示（参考层级化拆解思路）。"""

SHARED_STYLE = """你是一位专业中文影视编剧助理。输出使用清晰的中文剧本文面；
场标题可用「场次 + 简短地点」，对白格式：角色名（情绪/动作）：台词。
避免输出与剧本无关的解释性套话。"""


def phases() -> list[tuple[str, str, str]]:
    """返回 (phase_id, system_addon, instruction_template)，instruction 占位 {logline}, {prior}"""

    synopsis = SHARED_STYLE + "\n请根据一句话梗概，写出：故事梗概（300–500字）、主要人物小传（每人 3–5 句）、核心矛盾与主题句。"

    acts = (
        SHARED_STYLE
        + "\n根据已有梗概与人物，输出三幕或四幕结构：每幕目标、障碍、转折；每幕 3–5 个节拍点（一句话）。"""
    )

    scenes = (
        SHARED_STYLE
        + "\n根据分幕大纲，列出全片主要场次表：每场 1 行，含场次号、地点时间、本场戏剧任务、出场人物。"
    )

    expand = (
        SHARED_STYLE
        + "\n在已有场次表基础上，选取最具戏剧张力的连续 3–5 场，写出带对白的完整细纲级剧本片段（可含必要舞台指示）。"
    )

    return [
        (
            "synopsis",
            synopsis,
            "一句话梗概：\n{logline}\n\n用户补充要求：\n{notes}\n",
        ),
        (
            "act_outline",
            acts,
            "梗概与前序输出（可节选）：\n{prior}\n\n用户补充：\n{notes}\n",
        ),
        (
            "scene_list",
            scenes,
            "分幕与前序摘要：\n{prior}\n\n用户补充：\n{notes}\n",
        ),
        (
            "scene_expand",
            expand,
            "场次表与前序上下文：\n{prior}\n\n用户指定要展开的场景或用「自动」表示由你挑选。\n额外说明：\n{notes}\n",
        ),
    ]
