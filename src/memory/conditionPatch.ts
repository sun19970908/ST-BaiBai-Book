/**
 * 伤情局部更新协议(conditionPatch)。
 *
 * 背景:protagonist.condition / npcs.condition 是覆盖型字符串。整段覆盖有两个老问题:
 *   1. 模型只提"新伤",重写时容易把尚未解除的旧伤/活动限制挤掉;
 *   2. 「痊愈/恢复正常」时填空字符串,会一次清光所有伤情(等于自动回血)。
 *
 * conditionPatch 把已有 condition 切成编号片段(c1、c2…),只允许按编号替换/新增,
 * 未列入的片段由程序原样保留。片段编号只在**单次请求内**有效:注入时按同一套
 * splitConditionFragments 规则切分,解析返回时再按同规则切分,编号即对齐。
 */

import type { ConditionPatch } from './types';

/** 片段之间的显示/存储分隔符。 */
export const CONDITION_FRAGMENT_SEP = '；';

/** 片段编号前缀与正则(仅本请求内有效)。 */
const FRAGMENT_ID_RE = /^c(\d+)$/i;
export function conditionFragmentId(index: number): string {
  return `c${index + 1}`;
}

/**
 * 把一段 condition 切成编号片段。按中文/英文分号、句号、换行切,逗号不切
 * (「手臂受伤,夹板固定,暂不能提重物」应作为一个片段整体替换)。
 */
export function splitConditionFragments(condition: string | undefined): string[] {
  const text = (condition ?? '').trim();
  if (!text) return [];
  return text
    .split(/[；;。\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 把 condition 渲染成带编号的片段列表,供提示词注入;空则返回空串。 */
export function fmtConditionFragments(condition: string | undefined): string {
  return splitConditionFragments(condition)
    .map((frag, i) => `[${conditionFragmentId(i)}] ${frag}`)
    .join(CONDITION_FRAGMENT_SEP);
}

/**
 * 施加某个人物的 conditionPatch,返回新的 condition(可能是 undefined=清空)。
 * - replace:按 cN 定位旧片段;text 为空串 → 删除该片段;有内容 → 覆盖该片段。
 * - add:追加为新的尾部片段。
 * 未列入 replace 的旧片段原样保留。
 */
export function applyConditionPatch(
  current: string | undefined,
  patch: ConditionPatch | null | undefined,
): string | undefined {
  if (!patch) return current;
  const fragments = splitConditionFragments(current);
  const next = [...fragments];
  for (const op of patch.replace ?? []) {
    const m = typeof op.id === 'string' ? op.id.match(FRAGMENT_ID_RE) : null;
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= next.length) continue;
    const text = op.text.trim();
    if (!text) next.splice(idx, 1);
    else next[idx] = text;
  }
  for (const op of patch.add ?? []) {
    const text = op.text.trim();
    if (text) next.push(text);
  }
  const joined = next.join(CONDITION_FRAGMENT_SEP).trim();
  return joined || undefined;
}

/** 是否是一个有实际内容、可施加的补丁。 */
export function hasConditionPatchContent(patch: ConditionPatch | null | undefined): boolean {
  if (!patch) return false;
  const replace = patch.replace ?? [];
  const add = patch.add ?? [];
  return replace.length > 0 || add.some(op => op.text.trim().length > 0);
}
