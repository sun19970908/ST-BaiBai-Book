import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, editNpc, setProtagonist } from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '一段剧情。',
  extra: { bbs_leaf: { id: `manual-${++seq}`, text: '摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'manual-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const originalVector = settings.apiSettings.vector.enabled;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.vector.enabled = originalVector;
});

describe('手动覆盖主角状态时旧 conditionPatch 必须作废', () => {
  it('AI 叶子带补丁,手动改写后以手动值为准', () => {
    const ctx = useChat([message({ protagonist: { condition: '手臂受伤,夹板固定；自述还需休养三天', conditionPatch: { add: [{ text: '新扭伤脚踝' }] } } })]);
    expect(memory.protagonist.condition).toBe('手臂受伤,夹板固定；自述还需休养三天；新扭伤脚踝');
    expect(setProtagonist({ condition: '手臂受伤,已恢复' })).toBe(true);
    expect(memory.protagonist.condition).toBe('手臂受伤,已恢复');
    // 重放(而非仅内存)也不该把旧补丁加回来
    expect(deriveMemory(ctx.chat).protagonist.condition).toBe('手臂受伤,已恢复');
  });

  it('清空状态时补丁不得复活旧片段', () => {
    useChat([message({ protagonist: { condition: '手臂受伤；需休养', conditionPatch: { add: [{ text: '新扭伤脚踝' }] } } })]);
    expect(setProtagonist({ condition: '' })).toBe(true);
    expect(memory.protagonist.condition).toBeUndefined();
  });
});

describe('NPC 即时层支持手动清空', () => {
  it('清空 condition / outfit 生效', () => {
    useChat([message({ npcs: { add: [{ name: '艾琳', condition: '左肩中箭；不能拉弓', outfit: '染血披风' }] } })]);
    expect(memory.npcs[0].condition).toBe('左肩中箭；不能拉弓');
    expect(editNpc('艾琳', { condition: '', outfit: '' })).toBe(true);
    expect(memory.npcs[0].condition).toBeUndefined();
    expect(memory.npcs[0].outfit).toBeUndefined();
  });
});
