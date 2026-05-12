/**
 * 从 LLM 流水线某一阶段的原始文本中抽取 JSON，并写入角色 / 分镜 / 剪辑 API。
 */
import { apiFetch, getBackendBase } from '../hooks/useBackend';

export const EV_RELOAD_CHARACTERS = 'screenplay-reload-characters';
export const EV_RELOAD_STORYBOARD = 'screenplay-reload-storyboard';
export const EV_RELOAD_EDIT = 'screenplay-reload-edit-script';
export const EV_RELOAD_EPISODES = 'screenplay-reload-episodes';

/** 从 start 起截取与其匹配的顶层 `{ ... }`（字符串内的括号不计入），避免 lastIndexOf('}') 截断错误 */
function sliceBalancedJsonObject(payload: string, start: number): string | null {
  if (start < 0 || start >= payload.length || payload[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return payload.slice(start, i + 1);
    }
  }
  return null;
}

function sliceBalancedJsonArray(payload: string, start: number): string | null {
  if (start < 0 || start >= payload.length || payload[start] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return payload.slice(start, i + 1);
    }
  }
  return null;
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1].trim() : t;
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    const start = payload.indexOf('{');
    if (start >= 0) {
      const balanced = sliceBalancedJsonObject(payload, start);
      if (balanced) {
        try {
          const v = JSON.parse(balanced) as unknown;
          return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        } catch {
          /* fallthrough */
        }
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
    if (start >= 0) {
      const balanced = sliceBalancedJsonArray(payload, start);
      if (balanced) {
        try {
          const v = JSON.parse(balanced) as unknown;
          return Array.isArray(v) ? v : null;
        } catch {
          /* fallthrough */
        }
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
  const balanced = sliceBalancedJsonObject(raw, start);
  if (!balanced) return null;
  try {
    const p = JSON.parse(balanced) as Record<string, unknown>;
    return Array.isArray(p.characters) ? p.characters : null;
  } catch {
    return null;
  }
}

function shotListFromStoryboardRecord(o: Record<string, unknown>): unknown[] | null {
  for (const key of ['shots', 'storyboard', 'data'] as const) {
    const inner = o[key];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const nested = shotListFromStoryboardRecord(inner as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

function extractStoryboardShotList(raw: string): unknown[] | null {
  let arr = extractJsonArray(raw);
  if (arr && arr.length > 0) return arr;

  const o = extractJsonObject(raw);
  if (!o) return null;
  const fromKeys = shotListFromStoryboardRecord(o);
  if (fromKeys) return fromKeys;
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

/** 角色「AI 图片」字段：流水线可产出 character_sheet_prompt（完整角色板），否则从 visual_prompt 等组装 */
function pickCharacterImagePrompt(row: Record<string, unknown>): string {
  const sheet = str(row.character_sheet_prompt);
  if (sheet.length > 0) return sheet;

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

export type ImportCharactersOpts = {
  /** 续写：同名角色更新描述与 AI 提示词（PATCH）；新名称仍 POST */
  upsertExisting?: boolean;
};

/** 将 characters 阶段输出导入为项目角色；默认跳过已存在的名称；续写时可 upsert */
export async function importCharactersFromPhase(
  projectId: number,
  raw: string,
  opts?: ImportCharactersOpts,
): Promise<number> {
  const list = extractCharacterList(raw);
  if (!list || list.length === 0) return 0;

  const upsert = opts?.upsertExisting === true;

  const base = await getBackendBase();
  const existing = await apiFetch<{ characters: { id: number; name: string }[] }>(
    base,
    `/api/projects/${projectId}/characters`
  );
  const rows = existing.characters || [];
  const names = new Set(rows.map((c) => c.name));
  const nameToId = new Map(rows.map((c) => [c.name, c.id]));

  let changed = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const row = c as Record<string, unknown>;
    const name = str(row.name);
    if (!name) continue;

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
    const aiPrompt = pickCharacterImagePrompt(row);

    const existingId = nameToId.get(name);
    if (existingId != null && upsert) {
      await apiFetch(base, `/api/projects/${projectId}/characters/${existingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: descCore, ai_prompt: aiPrompt }),
      });
      changed += 1;
      continue;
    }

    if (names.has(name)) continue;

    const created = await apiFetch<{ id: number }>(base, `/api/projects/${projectId}/characters`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: descCore,
        ai_prompt: aiPrompt,
      }),
    });
    names.add(name);
    if (created?.id != null) nameToId.set(name, created.id);
    changed += 1;
  }
  return changed;
}

interface SceneDto {
  id: number;
  scene_number: number;
  location?: string;
  time_of_day?: string;
  description?: string;
}

/** 稳定排序：EP02-S01 < EP02-S02 < EP10-S01；无法解析的 key 排在后面 */
function compareStoryboardGroupKeys(a: string, b: string): number {
  const parse = (k: string): [number, number, string] => {
    const m = k.trim().match(/^EP(\d+)-S(\d+)$/i);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), k];
    const m2 = k.trim().match(/^EP(\d+)/i);
    if (m2) return [parseInt(m2[1], 10), 0, k];
    return [9999, 0, k];
  };
  const [ea, sa, ta] = parse(a);
  const [eb, sb, tb] = parse(b);
  if (ea !== eb) return ea - eb;
  if (sa !== sb) return sa - sb;
  return ta.localeCompare(tb);
}

/** 从分组键或场次 location 解析集号，如 EP02-S01 → 2 */
function parseEpNumFromStoryboardKey(k: string): number | null {
  const m = (k || '').trim().match(/^EP(\d+)-/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseEpNumFromSceneDto(sc: SceneDto): number | null {
  const loc = (sc.location ?? '').trim();
  return parseEpNumFromStoryboardKey(loc);
}

export type ImportStoryboardOpts = {
  /** novel_adapt 逐集 SSE 的当前集：无 EP 前缀的 shot_id（如 CUT-001）归入该集，避免全部落 EP01 */
  defaultEpisodeNumber?: number;
};

/** 将 storyboard 阶段输出的 JSON 镜头数组按 scene 字段分组，分别建场次后导入。
 *  appendMode = true: 续写模式——保留已有场次/镜头，只追加新的（按 groupKey 去重）
 *  非续写：默认按集**增量替换**——仅清空本次 JSON 中出现的 EP 的镜头，不删其它集；且不会用「第 gi 个旧场次」去 PATCH 成别的集。 */
export async function importStoryboardFromPhase(
  projectId: number,
  raw: string,
  appendMode = false,
  opts?: ImportStoryboardOpts,
): Promise<number> {
  const arr = extractStoryboardShotList(raw);
  if (!arr || arr.length === 0) return 0;

  const base = await getBackendBase();

  const scenesData = await apiFetch<{ scenes: SceneDto[] }>(base, `/api/projects/${projectId}/scenes`);

  // ── 分组：优先从 shot_id 提取 EP0N-S0N 格式，保证按集数分场次 ──────────────
  // Priority:
  //  1. shot_id like "EP01-S02-C03" → group "EP01-S02"
  //  2. shot_id like "EP01_S02_C03" → group "EP01-S02" (underscore variant)
  //  3. shot_id like "1-02-001"     → group "EP01-S02"
  //  4. scene / scene_id field that already contains EP prefix
  //  5. scene / scene_id field as-is (generic location names)
  //  6. fallback "EP01-S1"

  function makeGroupKey(row: Record<string, unknown>): string {
    const sid = str(row.shot_id);
    const defEp =
      opts?.defaultEpisodeNumber != null &&
      opts.defaultEpisodeNumber >= 1 &&
      opts.defaultEpisodeNumber <= 999
        ? opts.defaultEpisodeNumber
        : null;

    // EP01-S02-C03 or EP01_S02_C03 → "EP01-S02"
    const m1 = sid.match(/^(EP\d+)[-_](S\d+)/i);
    if (m1) return `${m1[1].toUpperCase()}-${m1[2].toUpperCase()}`;

    // 1-02-001 → "EP01-S02"
    const m2 = sid.match(/^(\d+)-(\d+)-/);
    if (m2) return `EP${m2[1].padStart(2, '0')}-S${m2[2].padStart(2, '0')}`;

    // scene / scene_id field
    const sceneField = str(row.scene) || str(row.scene_id);
    if (sceneField) {
      // If it already looks like "EP01-S01" keep as-is
      const m3 = sceneField.match(/^(EP\d+[-_]S\d+)/i);
      if (m3) return m3[1].toUpperCase().replace('_', '-');
      // If it contains episode info embed it
      const m4 = sceneField.match(/第\s*0*(\d+)\s*集/);
      if (m4) return `EP${m4[1].padStart(2, '0')}-S1`;
      // Generic location: prepend episode derived from shot_id prefix if possible
      const m5 = sid.match(/^(EP\d+)/i);
      if (m5) return `${m5[1].toUpperCase()}-${sceneField.slice(0, 20)}`;
      return sceneField;
    }

    // Two-segment shot_id like "EP01-C01"
    const m6 = sid.match(/^(EP\d+)/i);
    if (m6) return `${m6[1].toUpperCase()}-S1`;

    // 常见：剪辑式 shot_id CUT-025 无 EP，按流水线当前集归入（不致全部堆到 EP01）
    if (/^CUT-/i.test(sid) && defEp != null) {
      return `EP${String(defEp).padStart(2, '0')}-S1`;
    }

    if (defEp != null) {
      return `EP${String(defEp).padStart(2, '0')}-S1`;
    }

    return 'EP01-S1';
  }

  const groups: Map<string, (Record<string, unknown>)[]> = new Map();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const groupKey = makeGroupKey(row);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(row);
  }

  /** 本次导入涉及的集号（来自各组的 EP 前缀）；用于替换模式下只清这些集的镜头 */
  const importEpisodeNums = new Set<number>();
  for (const k of groups.keys()) {
    const ep = parseEpNumFromStoryboardKey(k);
    if (ep != null) importEpisodeNums.add(ep);
  }
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const sid = str((item as Record<string, unknown>).shot_id);
    const m = sid.match(/EP\s*(\d+)/i);
    if (m) importEpisodeNums.add(parseInt(m[1], 10));
  }

  if (!appendMode) {
    if (importEpisodeNums.size > 0) {
      for (const sc of scenesData.scenes || []) {
        const ep = parseEpNumFromSceneDto(sc);
        if (ep == null || !importEpisodeNums.has(ep)) continue;
        const existingShots = await apiFetch<{ shots: { id: number }[] }>(
          base,
          `/api/projects/${projectId}/scenes/${sc.id}/shots`
        );
        for (const sh of existingShots.shots || []) {
          await apiFetch(base, `/api/projects/${projectId}/scenes/${sc.id}/shots/${sh.id}`, { method: 'DELETE' });
        }
      }
    } else {
      // 无法从 JSON 识别 EP 时保持旧行为：清空全部镜头（整盘重导）
      for (const sc of scenesData.scenes || []) {
        const existingShots = await apiFetch<{ shots: { id: number }[] }>(
          base,
          `/api/projects/${projectId}/scenes/${sc.id}/shots`
        );
        for (const sh of existingShots.shots || []) {
          await apiFetch(base, `/api/projects/${projectId}/scenes/${sc.id}/shots/${sh.id}`, { method: 'DELETE' });
        }
      }
    }
  }

  const existingScenes = (scenesData.scenes || []).slice().sort((a, b) => a.scene_number - b.scene_number);
  const groupEntries = [...groups.entries()].sort(([ka], [kb]) => compareStoryboardGroupKeys(ka, kb));
  const sceneIdForGroup: Map<string, number> = new Map();

  // Build a location→scene map so we can find existing scenes by their groupKey
  const existingByLocation = new Map<string, SceneDto>();
  for (const sc of existingScenes) {
    const loc = (sc.location ?? '').trim();
    existingByLocation.set(loc || `__id_${sc.id}`, sc);
  }

  // Determine next scene_number for new scenes
  const maxExistingNum = existingScenes.length > 0
    ? Math.max(...existingScenes.map((s) => s.scene_number))
    : 0;
  let nextSceneNum = maxExistingNum + 1;

  for (const [groupKey] of groupEntries) {
    let sceneId: number;

    if (appendMode) {
      // In append mode: match by location (groupKey), reuse if found; otherwise create new
      const existing = existingByLocation.get(groupKey);
      if (existing) {
        sceneId = existing.id;
      } else {
        const s = await apiFetch<SceneDto>(base, `/api/projects/${projectId}/scenes`, {
          method: 'POST',
          body: JSON.stringify({
            scene_number: nextSceneNum++,
            location: groupKey,
            time_of_day: 'DAY',
            description: `分镜阶段自动导入：${groupKey}`,
          }),
        });
        sceneId = s.id;
      }
    } else {
      /* 非续写：只按 groupKey 复用同 location 的场次；禁止按序号 gi 拿「第几个旧场」去 PATCH 成别的集（会顶替掉第一集）。无匹配则新建场次。 */
      const matched = existingByLocation.get(groupKey);
      if (matched) {
        sceneId = matched.id;
      } else {
        const s = await apiFetch<SceneDto>(base, `/api/projects/${projectId}/scenes`, {
          method: 'POST',
          body: JSON.stringify({
            scene_number: nextSceneNum++,
            location: groupKey,
            time_of_day: 'DAY',
            description: `分镜阶段自动导入：${groupKey}`,
          }),
        });
        sceneId = s.id;
        existingByLocation.set(groupKey, s);
      }
    }
    sceneIdForGroup.set(groupKey, sceneId);
  }

  let n = 0;
  for (const [groupKey, shots] of groupEntries) {
    const sceneId = sceneIdForGroup.get(groupKey)!;
    for (let i = 0; i < shots.length; i++) {
      const row = shots[i];
      const shotContent =
        str(row.shot_content) || str(row.content) || str(row.description) || str(row.scene);
      const directorIntent =
        str(row.director_intent) || str(row.director_note) || str(row.intent);
      const cameraParams = str(row.camera_params) || str(row.lens);
      const lighting = str(row.lighting) || str(row.light);
      const colorTone = str(row.color_tone) || str(row.tone);
      const soundDesign = str(row.sound_design) || str(row.sfx) || str(row.sound);
      const subtitleText = str(row.subtitle_text) || str(row.subtitle) || str(row.sub_text);

      await apiFetch(base, `/api/projects/${projectId}/scenes/${sceneId}/shots`, {
        method: 'POST',
        body: JSON.stringify({
          shot_number: i + 1,
          shot_type: str(row.shot_type).slice(0, 24) || 'MS',
          camera_movement: str(row.camera_movement).slice(0, 32) || 'STATIC',
          action: str(row.action),
          dialogue: str(row.dialogue),
          ai_prompt: str(row.ai_image_prompt) || str(row.ai_prompt),
          animation_prompt: str(row.animation_prompt),
          duration_sec: typeof row.duration_sec === 'number' ? row.duration_sec : Number(row.duration_sec) || 3,
          shot_content: shotContent,
          director_intent: directorIntent,
          camera_params: cameraParams,
          lighting,
          color_tone: colorTone,
          sound_design: soundDesign,
          subtitle_text: subtitleText,
          timecode_in: str(row.timecode_in),
          timecode_out: str(row.timecode_out),
        }),
      });
      n += 1;
    }
  }
  return n;
}

/** 从集数规划阶段输出中抽取 episodes 数组并批量写入 */
export async function importEpisodesFromPhase(projectId: number, raw: string): Promise<number> {
  const o = extractJsonObject(raw);
  let list: unknown[] | null = null;
  if (o && Array.isArray(o.episodes)) {
    list = o.episodes;
  } else {
    const arr = extractJsonArray(raw);
    if (arr && arr.length > 0) {
      const first = arr[0];
      if (first && typeof first === 'object' && first !== null && ('ep_number' in (first as object) || 'title' in (first as object))) {
        list = arr;
      }
    }
  }
  if (!list || list.length === 0) return 0;

  const base = await getBackendBase();
  const episodes = list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((row, idx) => ({
      // ep_number 兼容 ep / ep_number / episode_number
      ep_number:
        typeof row.ep_number === 'number' ? row.ep_number :
        typeof row.ep === 'number' ? row.ep :
        Number(row.ep_number ?? row.ep ?? idx + 1) || idx + 1,
      title: str(row.title),
      core_event: str(row.core_event) || str(row.core_conflict) || str(row.main_event) || str(row.main_conflict),
      opening_hook: str(row.opening_hook) || str(row.hook_open),
      ending_hook: str(row.ending_hook) || str(row.hook_end) || str(row.cliffhanger),
      hook_type: str(row.hook_type),
      emotion_arc: str(row.emotion_arc) || str(row.emotional_arc),
      special_note: str(row.special_note) || str(row.note),
      script_content: str(row.script_content) || str(row.content),
      word_count: typeof row.word_count === 'number' ? row.word_count : 0,
      status: str(row.status) || 'planned',
    }));

  if (episodes.length === 0) return 0;

  const result = await apiFetch<{ count: number }>(
    base,
    `/api/projects/${projectId}/episodes/bulk`,
    { method: 'POST', body: JSON.stringify({ episodes }) }
  );
  return result.count ?? episodes.length;
}

const EDIT_EP_ORDER_BUCKET = 10_000;

/** 剪辑 meta：「第N集」「EPNN」 */
function parseEpisodeFromEditLabel(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const m1 = t.match(/第\s*(\d+)\s*集/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = t.match(/^EP\s*(\d+)/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function parseEpFromEditShotRef(ref: string): number | null {
  const m = ref.trim().match(/EP\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** 从 edit_script.episode + timeline[].shot_ref 推断本次导入涉及的集数（用于替换时只删本集剪辑） */
function inferEditImportEpisodesMeta(
  editScriptBlock: unknown,
  timelineRows: Record<string, unknown>[],
): Set<number> | null {
  const eps = new Set<number>();
  if (editScriptBlock && typeof editScriptBlock === 'object' && !Array.isArray(editScriptBlock)) {
    const me = parseEpisodeFromEditLabel(str((editScriptBlock as Record<string, unknown>).episode));
    if (me != null) eps.add(me);
  }
  for (const row of timelineRows) {
    const ep = parseEpFromEditShotRef(str(row.shot_ref || row.cut_id));
    if (ep != null) eps.add(ep);
  }
  return eps.size > 0 ? eps : null;
}

/** 将 edit_script 阶段输出的剪辑 JSON 导入为剪辑单。
 * - 替换模式：若能识别集号（shot_ref 中含 EPxx 和/或 episode 为「第N集」），只删除并重建**这些集**的剪辑条目，其余集保留。
 * - 无法识别集号时：与旧版相同，清空整张剪辑单后写入。
 * - 续写（append）：在末尾追加，并尽量写入 ep_number。 */
export async function importEditScriptFromPhase(
  projectId: number,
  raw: string,
  appendMode = false,
): Promise<number> {
  const parsed = extractJsonObject(raw);
  if (!parsed) return 0;

  let timeline: unknown[] | null = null;
  let editScriptBlock: unknown = null;
  const es = parsed.edit_script;
  if (es && typeof es === 'object' && !Array.isArray(es)) {
    editScriptBlock = es;
    const t = (es as Record<string, unknown>).timeline;
    if (Array.isArray(t)) timeline = t;
  }
  if (!timeline && Array.isArray(parsed.timeline)) timeline = parsed.timeline;

  if (!timeline || timeline.length === 0) return 0;

  const typedRows = timeline.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object',
  );

  const targetEpSet = inferEditImportEpisodesMeta(editScriptBlock, typedRows);

  const base = await getBackendBase();
  const existing = await apiFetch<
    { edit_shots: { id: number; order_index: number; ep_number: number | null }[] }
  >(base, `/api/projects/${projectId}/edit-shots`);

  const existingList = existing.edit_shots || [];

  if (appendMode) {
    const maxIdx = existingList.reduce((mx, sh) => Math.max(mx, sh.order_index), -1);
    const startIndex = maxIdx + 1;

    let n = 0;
    for (let i = 0; i < typedRows.length; i++) {
      const r = typedRows[i]!;
      const dur = Number(r.duration_sec);
      const duration = Number.isFinite(dur) && dur > 0 ? dur : 3;
      const tc = str(r.timecode_in) || '00:00:00:00';
      const sub = r.subtitle;
      const subText =
        sub && typeof sub === 'object' && sub !== null && 'text' in sub
          ? str((sub as Record<string, unknown>).text)
          : '';
      const singleEp = targetEpSet && targetEpSet.size === 1 ? [...targetEpSet][0]! : undefined;
      const epNum = parseEpFromEditShotRef(str(r.shot_ref || r.cut_id)) ?? singleEp;
      const note = [str(r.cut_id), str(r.director_note), subText].filter(Boolean).join(' | ').slice(0, 2000);

      await apiFetch(base, `/api/projects/${projectId}/edit-shots`, {
        method: 'POST',
        body: JSON.stringify({
          ...(epNum != null ? { ep_number: epNum } : {}),
          order_index: startIndex + i,
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

  if (targetEpSet == null) {
    for (const sh of existingList) {
      await apiFetch(base, `/api/projects/${projectId}/edit-shots/${sh.id}`, { method: 'DELETE' });
    }
  } else {
    for (const sh of existingList) {
      if (sh.ep_number != null && targetEpSet.has(sh.ep_number)) {
        await apiFetch(base, `/api/projects/${projectId}/edit-shots/${sh.id}`, { method: 'DELETE' });
      }
    }
  }

  const perEpCounter = new Map<number, number>();
  const bucketOrderFor = (ep: number): number => {
    const e = Math.max(1, ep);
    const i = perEpCounter.get(e) ?? 0;
    perEpCounter.set(e, i + 1);
    return (e - 1) * EDIT_EP_ORDER_BUCKET + i;
  };

  let n = 0;
  for (const r of typedRows) {
    const dur = Number(r.duration_sec);
    const duration = Number.isFinite(dur) && dur > 0 ? dur : 3;
    const tc = str(r.timecode_in) || '00:00:00:00';
    const sub = r.subtitle;
    const subText =
      sub && typeof sub === 'object' && sub !== null && 'text' in sub
        ? str((sub as Record<string, unknown>).text)
        : '';
    const singleEp = targetEpSet && targetEpSet.size === 1 ? [...targetEpSet][0]! : undefined;
    const epGuess = parseEpFromEditShotRef(str(r.shot_ref || r.cut_id)) ?? singleEp ?? 1;
    const note = [str(r.cut_id), str(r.director_note), subText].filter(Boolean).join(' | ').slice(0, 2000);

    await apiFetch(base, `/api/projects/${projectId}/edit-shots`, {
      method: 'POST',
      body: JSON.stringify({
        ep_number: epGuess,
        order_index: bucketOrderFor(epGuess),
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

export type ImportScriptEpisodesOpts = {
  /** 与生成任务一致的集数范围；续写时必填语义才正确（否则未识别段落会错误填到第 1 集起） */
  rangeStart?: number;
  rangeEnd?: number;
};

/**
 * 将 script_snippet / episode_scripts / novel_screenplay（小说改编剧本正文）阶段的多集剧本正文
 * 按集末标记「【本集完」拆分，自动 PATCH 到对应集数的 script_content。
 * 匹配规则：
 *   1. 先从每段识别集编号（第N集 / EPNN / 首行 N-场次）；能对上的写入对应集，同集多段合并。
 *   2. 凡提供了 rangeStart/rangeEnd：猜测集号落在范围外的一律视为未识别（防止「第5集」误入本轮批次）。
 *   3. 未识别段落按正文顺序只填入「范围内尚未分配到正文」的集位（续写 4–5 不会写入 1、2 集）。
 */
export async function importScriptSnippetToEpisodes(
  projectId: number,
  raw: string,
  opts?: ImportScriptEpisodesOpts,
): Promise<number> {
  type EpRow = {
    id: number;
    ep_number: number;
    script_content: string;
    status: string;
  };

  /**
   * 拆段策略（双重标记，防止某集缺少「本集完」导致整集内容被跳过）：
   * 1. 主分隔符：「【本集完」— 遇到则结束当前段并开新段
   * 2. 次分隔符：集首标记「第N集-」或「N-01」等新集开头 — 若当前段已有内容则也切段
   * 两种机制取最先出现的那个，确保每集都能被识别。
   */
  const EP_HEADER = /^(?:第\s*(\d+)\s*集|(\d+)-\d+)\s/;

  const segments: string[] = [];
  let cur = '';

  for (const line of raw.split('\n')) {
    // 检测是否是新集头（如"第2集-"或"2-01"），若当前已有内容则先保存
    if (EP_HEADER.test(line.trim()) && cur.trim().length > 30) {
      // 只有当前段不含「本集完」时才在集头切割（防止重复切）
      if (!/【本集完/.test(cur)) {
        segments.push(cur.trim());
        cur = '';
      }
    }
    cur += line + '\n';
    if (/【本集完/.test(line)) {
      const s = cur.trim();
      if (s.length > 30) segments.push(s);
      cur = '';
    }
  }
  // 最后一段（无结尾标记或未被集头切断的尾段）— 始终保留
  const tail = cur.trim();
  if (tail.length > 30) segments.push(tail);

  if (segments.length === 0) return 0;

  const base = await getBackendBase();
  // 拉取已有集数
  const data = await apiFetch<{ episodes: EpRow[] }>(
    base,
    `/api/projects/${projectId}/episodes`
  );
  const epsFull = data.episodes || [];
  const epsOrdered = epsFull.slice().sort((a, b) => a.ep_number - b.ep_number);
  const epRowsByNum = new Map<number, EpRow>();
  for (const ep of epsOrdered) {
    if (!epRowsByNum.has(ep.ep_number)) epRowsByNum.set(ep.ep_number, ep);
  }
  const epsUnique = [...epRowsByNum.values()].sort((a, b) => a.ep_number - b.ep_number);

  /** 从段首识别集号：第N集 / EPNN / 首行 N-场次 */
  function guessEpNumber(text: string): number | null {
    const head = text.slice(0, 600);
    const m1 = head.match(/第\s*(\d+)\s*集/);
    if (m1) return parseInt(m1[1], 10);
    const m2 = head.match(/^\s*EP\s*0*(\d+)/im);
    if (m2) return parseInt(m2[1], 10);
    const line1 = (text.trim().split('\n')[0] ?? '').trim();
    const m3 = line1.match(/^(\d+)\s*-\s*\d+/);
    if (m3) return parseInt(m3[1], 10);
    const m4 = head.match(/^\s*\[?\s*(\d+)\s*\]?\s*-\s*\[/m);
    if (m4) return parseInt(m4[1], 10);
    return null;
  }

  const rs = opts?.rangeStart;
  const re = opts?.rangeEnd;
  const rangeLocked =
    rs !== undefined &&
    re !== undefined &&
    Number.isFinite(rs) &&
    Number.isFinite(re) &&
    rs >= 1 &&
    re >= rs;

  const epNumsPresent = new Set(epsUnique.map((e) => e.ep_number));
  const byEp = new Map<number, string>();
  const unmatched: string[] = [];

  for (const seg of segments) {
    const n = guessEpNumber(seg);
    if (n != null && epNumsPresent.has(n)) {
      if (rangeLocked && (n < rs! || n > re!)) {
        unmatched.push(seg);
        continue;
      }
      const prev = byEp.get(n);
      byEp.set(n, prev ? `${prev}\n\n${seg}` : seg);
    } else {
      unmatched.push(seg);
    }
  }

  const fillSlots = rangeLocked
    ? epsUnique.filter((e) => e.ep_number >= rs! && e.ep_number <= re! && !byEp.has(e.ep_number))
    : epsUnique.filter((e) => !byEp.has(e.ep_number));

  for (const ep of fillSlots) {
    const seg = unmatched.shift();
    if (!seg) break;
    byEp.set(ep.ep_number, seg);
  }

  let updated = 0;
  for (const ep of epsUnique) {
    const seg = byEp.get(ep.ep_number);
    if (!seg?.trim()) continue;
    const row = epRowsByNum.get(ep.ep_number);
    if (!row) continue;
    await apiFetch(base, `/api/projects/${projectId}/episodes/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ script_content: seg, status: 'scripted' }),
    });
    updated += 1;
  }
  return updated;
}
