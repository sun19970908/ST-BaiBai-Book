import type { ProtagonistDelta } from './types';

/**
 * 把主角档案补丁合并进同一叶子的既有补丁。
 *
 * 年龄是一个二字段原子值(age + ageTime):调用方明确写 age、却没写 ageTime，
 * 表示这是「此刻的新年龄」，旧锚点必须一起移除，之后由重放层用本叶子的故事时间补上。
 * 普通对象展开无法表达删除，曾因此让新年龄继续套用旧锚点。
 */
export function mergeProtagonistDelta(
  current: ProtagonistDelta | undefined,
  patch: ProtagonistDelta,
): ProtagonistDelta {
  const merged: ProtagonistDelta = { ...(current ?? {}), ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'age') && !Object.prototype.hasOwnProperty.call(patch, 'ageTime')) {
    delete merged.ageTime;
  }
  // condition 是覆盖型文本。本次补丁一旦给出 condition(含空串=清空),同叶子残留的片段补丁
  // 就必须一并作废——否则重放会先写入新文本、再按旧编号施加一遍补丁,手动保存看着「没生效」
  // 且旧片段总被 add/replace 回来(越长越长)。补丁在前、condition 在后的合并顺序无法解决,
  // 只能在这里显式删除。
  if (Object.prototype.hasOwnProperty.call(patch, 'condition')) {
    delete merged.conditionPatch;
  }
  return merged;
}
