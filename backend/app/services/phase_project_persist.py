"""导演通过后：将「剧本正文 / 分镜 / 剪辑」写入项目数据库并校验可读性。

与前端 pipelineImport 语义对齐，避免仅靠前端 SSE 导入时的竞态与遗漏。
成功后由 SSE 告知前端跳过重复导入。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlmodel import Session, select

from ..db.models import Character, EditShot, Episode, Scene, StoryboardShot
from ..pipelines.character_export_parse import parse_character_export
from ..pipelines.episode_range_clip import parse_storyboard_shot_list

SCRIPT_PHASES = frozenset({"novel_screenplay", "script_snippet", "episode_scripts"})
STORYBOARD_PHASES = frozenset({"storyboard"})
EDIT_PHASES = frozenset({"edit_script"})
CHARACTER_PHASES = frozenset({"characters"})

PERSIST_GATE_PHASES = SCRIPT_PHASES | STORYBOARD_PHASES | EDIT_PHASES | CHARACTER_PHASES

_EP_HEADER_LINE = re.compile(r"^(?:第\s*(\d+)\s*集|(\d+)-\d+)\s")
_EP_IN_STRING = re.compile(r"EP\s*0*(\d+)", re.IGNORECASE)


@dataclass
class PersistReport:
    ok: bool
    detail: str
    counts: dict[str, int]


_MIN_EP_BODY_CHARS_VALIDATE = (
    24  # ≤40 时对「仅一场戏/极短钩子」误判失败率过高（续写某一集很常见）
)


def _strip_fence(text: str) -> str:
    t = text.strip()
    m = re.match(r"^\s*```(?:json)?\s*([\s\S]*?)```\s*$", t, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m2 = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m2:
        return m2.group(1).strip()
    return t


def _slice_json_object(payload: str, start: int) -> str | None:
    if start < 0 or start >= len(payload) or payload[start] != "{":
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(payload)):
        c = payload[i]
        if in_str:
            if esc:
                esc = False
                continue
            if c == "\\":
                esc = True
                continue
            if c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return payload[start : i + 1]
    return None


def _parse_edit_timeline(text: str) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    raw = _strip_fence(text)
    obj: dict[str, Any] | None = None
    try:
        v = json.loads(raw)
        if isinstance(v, dict):
            obj = v
    except json.JSONDecodeError:
        pass
    if obj is None:
        start = raw.find("{")
        if start < 0:
            return [], None
        balanced = _slice_json_object(raw, start)
        if not balanced:
            return [], None
        try:
            parsed = json.loads(balanced)
        except json.JSONDecodeError:
            return [], None
        obj = parsed if isinstance(parsed, dict) else None
    if not obj:
        return [], None
    es = obj.get("edit_script") if isinstance(obj, dict) else None
    block: dict[str, Any] | None = es if isinstance(es, dict) else None
    timeline: list[Any] | None = None
    if block and isinstance(block.get("timeline"), list):
        timeline = block["timeline"]
    elif isinstance(obj, dict) and isinstance(obj.get("timeline"), list):
        timeline = obj["timeline"]
    if not timeline:
        return [], block
    rows: list[dict[str, Any]] = []
    for item in timeline:
        if isinstance(item, dict):
            rows.append(item)
    return rows, block


def _parse_episode_label(s: str) -> int | None:
    t = (s or "").strip()
    if not t:
        return None
    m1 = re.search(r"第\s*(\d+)\s*集", t)
    if m1:
        return int(m1.group(1))
    m2 = re.match(r"^EP\s*(\d+)", t, re.I)
    if m2:
        return int(m2.group(1))
    return None


def _parse_ep_from_edit_ref(ref: str) -> int | None:
    m = _EP_IN_STRING.search(ref or "")
    return int(m.group(1)) if m else None


def _infer_edit_episodes(block: dict[str, Any] | None, rows: list[dict[str, Any]]) -> set[int] | None:
    eps: set[int] = set()
    if block:
        me = _parse_episode_label(str(block.get("episode") or ""))
        if me is not None:
            eps.add(me)
    for row in rows:
        ep = _parse_ep_from_edit_ref(str(row.get("shot_ref") or row.get("cut_id") or ""))
        if ep is not None:
            eps.add(ep)
    return eps if eps else None


def _split_script_segments(raw: str) -> list[str]:
    """按「集号行 / 场次行 / 【本集完」拆段；阈值略低以免极短钩子段落被整块丢弃。"""
    segments: list[str] = []
    cur = ""
    min_flush = 20
    min_tail = 20
    for line in raw.split("\n"):
        stripped = line.strip()
        if stripped and _EP_HEADER_LINE.match(stripped) and len(cur.strip()) > min_flush:
            if "【本集完" not in cur:
                segments.append(cur.strip())
                cur = ""
        cur += line + "\n"
        if "【本集完" in line:
            s = cur.strip()
            if len(s) > min_tail:
                segments.append(s)
            cur = ""
    tail = cur.strip()
    if len(tail) > min_tail:
        segments.append(tail)
    return segments


def _guess_ep_from_segment(text: str) -> int | None:
    head = text[:600]
    m1 = re.search(r"第\s*(\d+)\s*集", head)
    if m1:
        return int(m1.group(1))
    m2 = re.match(r"^\s*EP\s*0*(\d+)", head, re.I | re.M)
    if m2:
        return int(m2.group(1))
    line1 = (text.strip().split("\n")[0] if text.strip() else "").strip()
    m3 = re.match(r"^(\d+)\s*-\s*\d+", line1)
    if m3:
        return int(m3.group(1))
    m4 = re.match(r"^\s*\[?\s*(\d+)\s*\]?\s*-\s*\[", head, re.M)
    if m4:
        return int(m4.group(1))
    return None


def _persist_script_phases(
    session: Session,
    project_id: int,
    raw: str,
    *,
    episode_range_start: int | None,
    episode_range_end: int | None,
) -> PersistReport:
    stripped_full = (raw or "").strip()

    stmt = select(Episode).where(Episode.project_id == project_id)
    eps_list = list(session.exec(stmt).all())
    if not eps_list:
        return PersistReport(False, "项目下无集数行，请先完成分集规划", {})

    eps_full = sorted(eps_list, key=lambda e: e.ep_number)
    ep_rows_by_num: dict[int, Episode] = {}
    for ep in eps_full:
        if ep.ep_number not in ep_rows_by_num:
            ep_rows_by_num[ep.ep_number] = ep

    rs, re_ = episode_range_start, episode_range_end
    range_locked = rs is not None and re_ is not None and re_ >= rs >= 1
    lo = rs or 1
    hi = re_ or lo
    single_ep_locked = rs is not None and re_ is not None and rs == re_

    segments = _split_script_segments(raw)
    if (
        not segments
        and single_ep_locked
        and len(stripped_full) >= _MIN_EP_BODY_CHARS_VALIDATE
    ):
        # 小说逐集流水线常只产出「本集」全文而无「第N集」大行 / 无【本集完】钩子
        segments = [stripped_full]

    if not segments:
        return PersistReport(False, "未能从正文拆出任何「本集」段落（缺少【本集完或集号结构）", {})

    ep_nums_present = set(ep_rows_by_num.keys())
    by_ep: dict[int, str] = {}
    unmatched: list[str] = []

    for seg in segments:
        n = _guess_ep_from_segment(seg)
        if n is not None and n in ep_nums_present:
            if range_locked and (n < lo or n > hi):
                unmatched.append(seg)
                continue
            prev = by_ep.get(n)
            by_ep[n] = f"{prev}\n\n{seg}" if prev else seg
        else:
            unmatched.append(seg)

    fill_slots = (
        sorted([e for e in ep_rows_by_num.values() if lo <= e.ep_number <= hi], key=lambda x: x.ep_number)
        if range_locked
        else sorted([e for e in ep_rows_by_num.values() if e.ep_number not in by_ep], key=lambda x: x.ep_number)
    )

    for ep in fill_slots:
        seg = unmatched.pop(0) if unmatched else None
        if not seg:
            break
        by_ep[ep.ep_number] = seg

    # 小说逐集只写一集时常无「第N集」前缀：目标集仍未写入或正文过短时，聚拢未命中段落或用全文兜底。
    if range_locked and single_ep_locked and rs is not None:
        tg = rs
        body_cur = str(by_ep.get(tg, "") or "").strip()
        weak = tg not in by_ep or len(body_cur) < _MIN_EP_BODY_CHARS_VALIDATE
        if weak:
            salvage = "\n\n".join(u.strip() for u in unmatched if u.strip()).strip()
            chosen = salvage or stripped_full
            if len(chosen) >= _MIN_EP_BODY_CHARS_VALIDATE:
                by_ep[tg] = chosen

    updated = 0
    for ep_num, body in by_ep.items():
        if not body.strip():
            continue
        row = ep_rows_by_num.get(ep_num)
        if not row:
            continue
        t = body.strip()
        row.script_content = t
        row.word_count = len(t)
        row.status = "scripted"
        session.add(row)
        updated += 1

    if updated < 1:
        return PersistReport(False, "剧本正文未能匹配到任何已有集数的「本集」槽位", {"segments": len(segments)})

    session.commit()

    bad: list[int] = []
    check_lo, check_hi = (lo, hi) if range_locked else (min(by_ep.keys()), max(by_ep.keys()))
    for epn in range(check_lo, check_hi + 1):
        ep = ep_rows_by_num.get(epn)
        if not ep:
            continue
        if len((ep.script_content or "").strip()) < _MIN_EP_BODY_CHARS_VALIDATE:
            bad.append(epn)

    if range_locked and bad:
        return PersistReport(
            False,
            f"以下集数字数不足或未写入：{bad}（每集约 {_MIN_EP_BODY_CHARS_VALIDATE}+ 字符）",
            {"episodes_written": updated},
        )

    return PersistReport(True, "剧本正文已写入集数库", {"episodes_written": updated})


def _str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def _parse_ep_num_from_storyboard_key(k: str) -> int | None:
    m = re.match(r"^EP(\d+)-", (k or "").strip(), re.I)
    return int(m.group(1)) if m else None


def _make_storyboard_group_key(
    row: dict[str, Any],
    *,
    default_ep: int | None,
) -> str:
    sid = _str(row.get("shot_id"))
    def_ep = default_ep if default_ep is not None and 1 <= default_ep <= 999 else None

    m1 = re.match(r"^(EP\d+)[-_](S\d+)", sid, re.I)
    if m1:
        return f"{m1.group(1).upper()}-{m1.group(2).upper()}"

    m2 = re.match(r"^(\d+)-(\d+)-", sid)
    if m2:
        return f"EP{int(m2.group(1)):02d}-S{int(m2.group(2)):02d}"

    scene_field = _str(row.get("scene")) or _str(row.get("scene_id"))
    if scene_field:
        m3 = re.match(r"^(EP\d+[-_]S\d+)", scene_field, re.I)
        if m3:
            return m3.group(1).upper().replace("_", "-")
        m4 = re.search(r"第\s*0*(\d+)\s*集", scene_field)
        if m4:
            return f"EP{int(m4.group(1)):02d}-S1"
        m5 = re.match(r"^(EP\d+)", sid, re.I)
        if m5:
            return f"{m5.group(1).upper()}-{scene_field[:20]}"
        return scene_field

    m6 = re.match(r"^(EP\d+)", sid, re.I)
    if m6:
        return f"{m6.group(1).upper()}-S1"

    if re.match(r"^CUT-", sid, re.I) and def_ep is not None:
        return f"EP{def_ep:02d}-S1"

    if def_ep is not None:
        return f"EP{def_ep:02d}-S1"

    return "EP01-S1"


def _persist_storyboard(
    session: Session,
    project_id: int,
    raw: str,
    *,
    episode_range_start: int | None,
    append_mode: bool,
) -> PersistReport:
    arr = parse_storyboard_shot_list(raw)
    if not arr:
        return PersistReport(False, "分镜 JSON 无法解析为镜头数组", {})
    shots_in: list[dict[str, Any]] = [x for x in arr if isinstance(x, dict)]
    if not shots_in:
        return PersistReport(False, "分镜数组中无有效镜头对象", {})

    def_ep = episode_range_start if episode_range_start is not None else None

    groups: dict[str, list[dict[str, Any]]] = {}
    for row in shots_in:
        gk = _make_storyboard_group_key(row, default_ep=def_ep)
        groups.setdefault(gk, []).append(row)

    import_ep_nums: set[int] = set()
    for k in groups:
        en = _parse_ep_num_from_storyboard_key(k)
        if en is not None:
            import_ep_nums.add(en)
    for row in shots_in:
        sid = _str(row.get("shot_id"))
        m = _EP_IN_STRING.search(sid)
        if m:
            import_ep_nums.add(int(m.group(1)))

    if not append_mode and import_ep_nums:
        scenes = list(session.exec(select(Scene).where(Scene.project_id == project_id)).all())
        for sc in scenes:
            ep = _parse_ep_num_from_storyboard_key((sc.location or "").strip())
            if ep is None or ep not in import_ep_nums:
                continue
            existing = list(
                session.exec(
                    select(StoryboardShot).where(
                        StoryboardShot.scene_id == sc.id,
                        StoryboardShot.project_id == project_id,
                    )
                ).all()
            )
            for sh in existing:
                session.delete(sh)

    scenes_all = sorted(
        list(session.exec(select(Scene).where(Scene.project_id == project_id)).all()),
        key=lambda s: s.scene_number,
    )
    existing_by_loc = {(s.location or "").strip() or f"__id_{s.id}": s for s in scenes_all}
    max_num = max((s.scene_number for s in scenes_all), default=0)
    next_scene_num = max_num + 1

    scene_ids: dict[str, int] = {}
    for gk in sorted(groups.keys()):
        ex = existing_by_loc.get(gk)
        if ex:
            scene_ids[gk] = ex.id
        else:
            sc = Scene(
                project_id=project_id,
                scene_number=next_scene_num,
                location=gk,
                time_of_day="DAY",
                description=f"分镜阶段服务端入库：{gk}",
            )
            next_scene_num += 1
            session.add(sc)
            session.flush()
            scene_ids[gk] = sc.id
            existing_by_loc[gk] = sc

    n = 0
    for gk in sorted(groups.keys()):
        sid_scene = scene_ids[gk]
        for i, row in enumerate(groups[gk]):
            shot_content = _str(row.get("shot_content")) or _str(row.get("content")) or _str(row.get("description")) or _str(row.get("scene"))
            director_intent = (
                _str(row.get("director_intent"))
                or _str(row.get("director_note"))
                or _str(row.get("intent"))
            )
            dur_raw = row.get("duration_sec")
            dur = float(dur_raw) if isinstance(dur_raw, (int, float)) else float(dur_raw or 3)
            sh = StoryboardShot(
                project_id=project_id,
                scene_id=sid_scene,
                shot_number=i + 1,
                shot_type=_str(row.get("shot_type"))[:24] or "MS",
                camera_movement=_str(row.get("camera_movement"))[:32] or "STATIC",
                action=_str(row.get("action")),
                dialogue=_str(row.get("dialogue")),
                ai_prompt=_str(row.get("ai_image_prompt")) or _str(row.get("ai_prompt")),
                animation_prompt=_str(row.get("animation_prompt")),
                duration_sec=dur if dur > 0 else 3.0,
                shot_content=shot_content,
                director_intent=director_intent,
                camera_params=_str(row.get("camera_params")) or _str(row.get("lens")),
                lighting=_str(row.get("lighting")) or _str(row.get("light")),
                color_tone=_str(row.get("color_tone")) or _str(row.get("tone")),
                sound_design=_str(row.get("sound_design")) or _str(row.get("sfx")) or _str(row.get("sound")),
                subtitle_text=_str(row.get("subtitle_text")) or _str(row.get("subtitle")) or _str(row.get("sub_text")),
                timecode_in=_str(row.get("timecode_in")),
                timecode_out=_str(row.get("timecode_out")),
            )
            session.add(sh)
            n += 1

    session.commit()

    if n != len(shots_in):
        return PersistReport(False, f"入库镜头数 {n} 与解析条数 {len(shots_in)} 不一致", {"shots": n})

    return PersistReport(True, "分镜镜头已写入数据库", {"storyboard_shots": n})


EDIT_EP_BUCKET = 10_000


def _persist_edit_script(
    session: Session,
    project_id: int,
    raw: str,
    *,
    append_mode: bool,
    episode_range_start: int | None = None,
    episode_range_end: int | None = None,
) -> PersistReport:
    rows, block = _parse_edit_timeline(raw)
    if not rows:
        return PersistReport(False, "剪辑 JSON 无 timeline 或无法解析", {})

    target_eps = _infer_edit_episodes(block, rows)
    # 小说逐集流水线：模型常在 timeline 里不写 EP，仅用当前 ctx 集号收口删除与 ep_number 推断
    if target_eps is None and episode_range_start is not None:
        lo = episode_range_start
        hi = episode_range_end if episode_range_end is not None else lo
        if hi >= lo:
            target_eps = set(range(lo, hi + 1))

    existing = list(session.exec(select(EditShot).where(EditShot.project_id == project_id)).all())

    if not append_mode:
        if target_eps is None:
            for sh in existing:
                session.delete(sh)
        else:
            for sh in existing:
                if sh.ep_number is not None and sh.ep_number in target_eps:
                    session.delete(sh)
        session.flush()

    single_ep = next(iter(target_eps)) if target_eps and len(target_eps) == 1 else None
    max_idx = max((sh.order_index for sh in existing), default=-1)
    start_index = max_idx + 1 if append_mode else 0

    per_ep_counter: dict[int, int] = {}

    def bucket_order(ep: int) -> int:
        e = max(1, ep)
        i = per_ep_counter.get(e, 0)
        per_ep_counter[e] = i + 1
        return (e - 1) * EDIT_EP_BUCKET + i

    n = 0
    for i, r in enumerate(rows):
        dur = float(r.get("duration_sec") or 3)
        if not (dur > 0 and dur < 1e6):
            dur = 3.0
        tc = _str(r.get("timecode_in")) or "00:00:00:00"
        sub = r.get("subtitle")
        sub_text = _str(sub.get("text")) if isinstance(sub, dict) else ""
        ep_guess = (
            _parse_ep_from_edit_ref(_str(r.get("shot_ref") or r.get("cut_id")))
            or single_ep
            or 1
        )
        note = " | ".join(
            x for x in (_str(r.get("cut_id")), _str(r.get("director_note")), sub_text) if x
        )[:2000]
        order_index = (start_index + i) if append_mode else bucket_order(ep_guess)
        esh = EditShot(
            project_id=project_id,
            storyboard_shot_id=None,
            ep_number=ep_guess,
            order_index=order_index,
            in_point=0.0,
            out_point=max(0.5, dur),
            timecode=tc,
            note=note,
        )
        session.add(esh)
        n += 1

    session.commit()

    if n != len(rows):
        return PersistReport(False, f"剪辑条目写入数 {n} 与 timeline {len(rows)} 不一致", {"edit_shots": n})

    return PersistReport(True, "剪辑单已写入数据库", {"edit_shots": n})


_TV_FRAME = (
    "人物设定三视图：同一角色正面、侧面、背面全身立绘水平排列，纯白或浅灰纯色背景，"
    "全身入镜、比例一致，服装发型配饰在各视角完全对应，线条干净、便于后续镜头保持造型一致；"
)


def _py_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def _has_three_view_intent(text: str) -> bool:
    return bool(
        re.search(
            r"三视图|三視圖|三视|正侧背|正面.*侧面.*背面|turnaround|orthographic|character\s*sheet",
            text,
            re.I,
        )
    )


def _as_character_three_view_prompt(visual_body: str) -> str:
    body = visual_body.strip()
    if not body:
        return _TV_FRAME.rstrip("；")
    if _has_three_view_intent(body):
        return body
    return _TV_FRAME + body


def _pick_character_ai_prompt(row: dict[str, Any]) -> str:
    sheet = _py_str(row.get("character_sheet_prompt"))
    if sheet:
        return sheet
    direct_candidates = [
        row.get("visual_prompt"),
        row.get("appearance"),
        row.get("look"),
        row.get("ai_image_prompt"),
        row.get("image_prompt"),
        row.get("portrait_prompt"),
        row.get("three_view_prompt"),
    ]
    for d in direct_candidates:
        s = _py_str(d)
        if s:
            return _as_character_three_view_prompt(s)
    gender = _py_str(row.get("gender"))
    role = _py_str(row.get("role"))
    identity = _py_str(row.get("identity"))
    pers = row.get("personality")
    plist = [_py_str(x) for x in pers] if isinstance(pers, list) else []
    bits = [
        f"性别：{gender}" if gender else "",
        f"剧本定位：{role}" if role else "",
        f"身份与背景：{identity}" if identity else "",
        f"外貌气质关键词（用于造型）：{'、'.join(plist)}" if plist else "",
        "现代都市短剧造型风格，材质与剪裁简洁清晰",
    ]
    joined = "；".join(b for b in bits if b)
    return _as_character_three_view_prompt(joined)


def _character_description_core(row: dict[str, Any]) -> str:
    parts: list[str] = []
    iden = _py_str(row.get("identity"))
    if iden:
        parts.append(f"身份：{iden}")
    cm = _py_str(row.get("core_motivation"))
    if cm:
        parts.append(f"动机：{cm}")
    cf = _py_str(row.get("core_fear"))
    if cf:
        parts.append(f"恐惧/软肋：{cf}")
    pers = row.get("personality")
    if isinstance(pers, list) and pers:
        parts.append(f"性格：{'、'.join(_py_str(x) for x in pers)}")
    arc = _py_str(row.get("arc"))
    if arc:
        parts.append(f"弧线：{arc}")
    sh = _py_str(row.get("speech_habit"))
    if sh:
        parts.append(f"口癖/语气：{sh}")
    sig = row.get("signature_lines")
    if isinstance(sig, list) and sig:
        sl = "；".join(_py_str(x) for x in sig if _py_str(x))
        if sl:
            parts.append(f"台词风格示例：{sl}")
    core = "\n".join(parts)
    if core:
        return core
    return _py_str(row.get("role")) or "（由流水线导入）"


def _persist_characters(session: Session, project_id: int, raw: str) -> PersistReport:
    rows, err = parse_character_export(raw)
    if not rows:
        return PersistReport(False, err or "角色 JSON 无效", {})

    existing_list = list(session.exec(select(Character).where(Character.project_id == project_id)).all())
    by_name: dict[str, Character] = {(c.name or "").strip(): c for c in existing_list}

    n_new = 0
    n_up = 0
    for row in rows:
        name = _py_str(row.get("name"))
        if not name:
            session.rollback()
            return PersistReport(False, "存在空的角色 name", {})
        desc = _character_description_core(row)
        ai = _pick_character_ai_prompt(row)
        prev = by_name.get(name)
        if prev:
            prev.description = desc
            prev.ai_prompt = ai
            prev.updated_at = datetime.utcnow()
            session.add(prev)
            n_up += 1
        else:
            ch = Character(project_id=project_id, name=name, description=desc, ai_prompt=ai)
            session.add(ch)
            session.flush()
            by_name[name] = ch
            n_new += 1

    session.commit()

    verify_list = list(session.exec(select(Character).where(Character.project_id == project_id)).all())
    verify_names = {(c.name or "").strip() for c in verify_list}
    for row in rows:
        nm = _py_str(row.get("name"))
        if nm not in verify_names:
            return PersistReport(False, f"校验失败：角色「{nm}」未出现在数据库", {})

    return PersistReport(
        True,
        "角色已写入数据库",
        {"characters_new": n_new, "characters_updated": n_up, "characters_rows": len(rows)},
    )


def persist_phase_after_director_pass(
    session: Session,
    *,
    project_id: int | None,
    phase_id: str,
    text: str,
    episode_range_start: int | None,
    episode_range_end: int | None,
) -> PersistReport:
    """导演 PASS 之后调用：写入并校验。失败时不抛异常，由编排层决定是否格式自愈重试。"""
    if project_id is None:
        return PersistReport(False, "未绑定 project_id", {})

    append_import = episode_range_start is not None and episode_range_start > 1

    try:
        if phase_id in SCRIPT_PHASES:
            return _persist_script_phases(
                session,
                project_id,
                text,
                episode_range_start=episode_range_start,
                episode_range_end=episode_range_end,
            )
        if phase_id in STORYBOARD_PHASES:
            return _persist_storyboard(
                session,
                project_id,
                text,
                episode_range_start=episode_range_start,
                append_mode=append_import,
            )
        if phase_id in EDIT_PHASES:
            return _persist_edit_script(
                session,
                project_id,
                text,
                append_mode=append_import,
                episode_range_start=episode_range_start,
                episode_range_end=episode_range_end,
            )
        if phase_id in CHARACTER_PHASES:
            return _persist_characters(session, project_id, text)
    except Exception as exc:
        session.rollback()
        return PersistReport(False, f"入库异常：{exc}", {})

    return PersistReport(False, f"阶段 {phase_id} 不参与服务端入库", {})
