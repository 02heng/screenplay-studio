/**
 * 从 LLM 流水线某一阶段的原始文本中抽取 JSON，并写入角色 / 分镜 / 剪辑 API。
 */
import { apiFetch, getBackendBase } from '../hooks/useBackend';

export const EV_RELOAD_CHARACTERS = 'screenplay-reload-characters';
export const EV_RELOAD_STORYBOARD = 'screenplay-reload-storyboard';
export const EV_RELOAD_EDIT = 'screenplay-reload-edit-script';

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1].trim() : t;
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    const start = payload.indexOf('{');
    const end = payload.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const v = JSON.parse(payload.slice(start, end + 1)) as unknown;
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function extractJsonArray(text: string): unknown[] | null {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1].trim() : t;
  try {
    const v = JSON.parse(payload) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    const start = payload.indexOf('[');
    const end = payload.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const v = JSON.parse(payload.slice(start, end + 1)) as unknown;
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 从含前言、后语的模型输出中尽量抠出人物 JSON 数组 */
function extractCharacterList(raw: string): unknown[] | null {
  const o = extractJsonObject(raw);
  if (o && Array.isArray(o.characters)) return o.characters;

  const arr = extractJsonArray(raw);
  if (arr && arr.length > 0) {
    const first = arr[0];
    if (first && typeof first === 'object' && first !== null && 'name' in (first as object)) return arr;
  }

  const key = raw.indexOf('"characters"');
  if (key === -1) return null;
  let start = raw.lastIndexOf('{', key);
  if (start === -1) start = raw.indexOf('{');
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (start < 0 || end <= start) return null;
  try {
    const p = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return Array.isArray(p.characters) ? p.characters : null;
  } catch {
    return null;
  }
}

function extractStoryboardShotList(raw: string): unknown[] | null {
  let arr = extractJsonArray(raw);
  if (arr && arr.length > 0) return arr;

  const o = extractJsonObject(raw);
  if (!o) return null;
  if (Array.isArray(o.shots)) return o.shots;
  const inner = o.storyboard;
  if (Array.isArray(inner)) return inner;
  const inner2 = o.data;
  if (Array.isArray(inner2)) return inner2;
  return null;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** 角色表默认三视图出图框架（与单镜头分镜图分开使用） */
const CHARACTER_THREE_VIEW_FRAME =
  '人物设定三视图：同一角色正面、侧面、背面全身立绘水平排列，纯白或浅灰纯色背景，全身入镜、比例一致，服装发型配饰在各视角完全对应，线条干净、便于后续镜头保持造型一致；';

function hasThreeViewIntent(text: string): boolean {
  return /三视图|三視圖|三视|正侧背|正面.*侧面.*背面|turnaround|orthographic|character\s*sheet/i.test(text);
}

/** 将造型描述包成三视图定妆提示词 */
function asCharacterThreeViewPrompt(visualBody: string): string {
  const body = visualBody.trim();
  if (!body) return CHARACTER_THREE_VIEW_FRAME.slice(0, -1);
  if (hasThreeViewIntent(body)) return body;
  return `${CHARACTER_THREE_VIEW_FRAME}${body}`;
}

/** 角色「AI 图片」字段：画面向描述 + 统一为三视图定妆表 */
function pickCharacterImagePrompt(row: Record<string, unknown>): string {
  const direct = [
    str(row.visual_prompt),
    str(row.appearance),
    str(row.look),
    str(row.ai_image_prompt),
    str(row.image_prompt),
    str(row.portrait_prompt),
    str(row.three_view_prompt),
  ].find((s) => s.length > 0);

  if (direct) return asCharacterThreeViewPrompt(direct);

  const gender = str(row.gender);
  const role = str(row.role);
  const identity = str(row.identity);
  const pers = Array.isArray(row.personality)
    ? (row.personality as unknown[]).map((x) => str(x)).filter(Boolean)
    : [];
  const bits = [
    gender && `性别：${gender}`,
    role && `剧本定位：${role}`,
    identity && `身份与背景：${identity}`,
    pers.length > 0 && `外貌气质关键词（用于造型）：${pers.join('、')}`,
    '现代都市短剧造型风格，材质与剪裁简洁清晰',
  ].filter(Boolean);
  return asCharacterThreeViewPrompt(bits.join('；'));
}

/** 将 characters 阶段输出导入为项目角色（按名称去重） */
export async function importCharactersFromPhase(projectId: number, raw: string): Promise<number> {
  const list = extractCharacterList(raw);
  if (!list || list.length === 0) return 0;

  const base = await getBackendBase();
  const existing = await apiFetch<{ characters: { name: string }[] }>(
    base,
    `/api/projects/${projectId}/characters`
  );
  const names = new Set((existing.characters || []).map((c) => c.name));

  let added = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const row = c as Record<string, unknown>;
    const name = str(row.name);
    if (!name || names.has(name)) continue;

    const parts = [
      str(row.identity) && `身份：${str(row.identity)}`,
      str(row.core_motivation) && `动机：${str(row.core_motivation)}`,
      str(row.core_fear) && `恐惧/软肋：${str(row.core_fear)}`,
      Array.isArray(row.personality) && (row.personality as unknown[]).length
        ? `性格：${(row.personality as unknown[]).map((x) => str(x)).join('、')}`
        : '',
      str(row.arc) && `弧线：${str(row.arc)}`,
      str(row.speech_habit) && `口癖/语气：${str(row.speech_habit)}`,
    ].filter(Boolean);

    const sig = row.signature_lines;
    const sigLine = Array.isArray(sig) ? (sig as unknown[]).map((x) => str(x)).filter(Boolean).join('；') : '';
    if (sigLine) parts.push(`台词风格示例：${sigLine}`);

    const descCore = parts.join('\n') || str(row.role) || '（由流水线导入）';

    await apiFetch(base, `/api/projects/${projectId}/characters`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: descCore,
        ai_prompt: pickCharacterImagePrompt(row),
      }),
    });
    names.add(name);
    added += 1;
  }
  return added;
}

interface SceneDto {
  id: number;
  scene_number: number;
}

/** 将 storyboard 阶段输出的 JSON 镜头数组导入到第一个场次（无场次则新建） */
export async function importStoryboardFromPhase(projectId: number, raw: string): Promise<number> {
  const arr = extractStoryboardShotList(raw);
  if (!arr || arr.length === 0) return 0;

  const base = await getBackendBase();
  const scenesData = await apiFetch<{ scenes: SceneDto[] }>(base, `/api/projects/${projectId}/scenes`);
  const scenesList = scenesData.scenes || [];
  let sceneId: number;

  if (scenesList.length === 0) {
    const s = await apiFetch<SceneDto>(base, `/api/projects/${projectId}/scenes`, {
      method: 'POST',
      body: JSON.stringify({
        scene_number: 1,
        location: '流水线路径',
        time_of_day: 'DAY',
        description: '由剧本流水线「分镜」阶段自动导入',
      }),
    });
    sceneId = s.id;
  } else {
    sceneId = scenesList[0].id;
    const existingShots = await apiFetch<{ shots: { id: number }[] }>(
      base,
      `/api/projects/${projectId}/scenes/${sceneId}/shots`
    );
    for (const sh of existingShots.shots || []) {
      await apiFetch(
        base,
        `/api/projects/${projectId}/scenes/${sceneId}/shots/${sh.id}`,
        { method: 'DELETE' }
      );
    }
  }

  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    await apiFetch(base, `/api/projects/${projectId}/scenes/${sceneId}/shots`, {
      method: 'POST',
      body: JSON.stringify({
        shot_number: i + 1,
        shot_type: str(row.shot_type).slice(0, 24) || 'MS',
        camera_movement: str(row.camera_movement).slice(0, 32) || 'STATIC',
        action: [str(row.scene), str(row.action)].filter(Boolean).join(' · ') || str(row.action),
        dialogue: str(row.dialogue),
        ai_prompt: str(row.ai_image_prompt) || str(row.ai_prompt),
        animation_prompt: str(row.animation_prompt),
        duration_sec: typeof row.duration_sec === 'number' ? row.duration_sec : Number(row.duration_sec) || 3,
      }),
    });
    n += 1;
  }
  return n;
}

/** 将 edit_script 阶段输出的剪辑 JSON 导入为剪辑单（会清空本项目的旧剪辑条） */
export async function importEditScriptFromPhase(projectId: number, raw: string): Promise<number> {
  const parsed = extractJsonObject(raw);
  if (!parsed) return 0;

  let timeline: unknown[] | null = null;
  const es = parsed.edit_script;
  if (es && typeof es === 'object' && !Array.isArray(es)) {
    const t = (es as Record<string, unknown>).timeline;
    if (Array.isArray(t)) timeline = t;
  }
  if (!timeline && Array.isArray(parsed.timeline)) timeline = parsed.timeline;

  if (!timeline || timeline.length === 0) return 0;

  const base = await getBackendBase();
  const existing = await apiFetch<{ edit_shots: { id: number }[] }>(
    base,
    `/api/projects/${projectId}/edit-shots`
  );
  for (const sh of existing.edit_shots || []) {
    await apiFetch(base, `/api/projects/${projectId}/edit-shots/${sh.id}`, { method: 'DELETE' });
  }

  let n = 0;
  for (let i = 0; i < timeline.length; i++) {
    const row = timeline[i];
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const dur = Number(r.duration_sec);
    const duration = Number.isFinite(dur) && dur > 0 ? dur : 3;
    const tc = str(r.timecode_in) || '00:00:00:00';
    const sub = r.subtitle;
    const subText =
      sub && typeof sub === 'object' && sub !== null && 'text' in sub
        ? str((sub as Record<string, unknown>).text)
        : '';
    const note = [str(r.cut_id), str(r.director_note), subText].filter(Boolean).join(' | ').slice(0, 2000);

    await apiFetch(base, `/api/projects/${projectId}/edit-shots`, {
      method: 'POST',
      body: JSON.stringify({
        order_index: i,
        timecode: tc,
        in_point: 0,
        out_point: Math.max(0.5, duration),
        note,
        storyboard_shot_id: null,
      }),
    });
    n += 1;
  }
  return n;
}
