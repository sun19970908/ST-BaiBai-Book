import { describe, expect, it } from 'vitest';
import { applyConditionPatch, fmtConditionFragments, splitConditionFragments } from './conditionPatch';
import { deriveMemory, finalizeDelta } from './apply';
import type { STMessage } from '@/st/context';
import type { StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '一段明确发生的剧情。',
  extra: { bbs_leaf: { id: `cond-${++seq}`, text: '剧情摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});

describe('conditionPatch 片段切分', () => {
  it('按分号/句号/换行切,逗号不切', () => {
    expect(splitConditionFragments('手臂受伤,夹板固定,暂不能提重物；自述还需休养几天。左腿擦伤'))
      .toEqual(['手臂受伤,夹板固定,暂不能提重物', '自述还需休养几天', '左腿擦伤']);
  });

  it('渲染为 [c1]/[c2] 编号片段', () => {
    expect(fmtConditionFragments('手臂受伤；需休养')).toBe('[c1] 手臂受伤；[c2] 需休养');
  });
});

describe('applyConditionPatch', () => {
  it('replace 只改指定编号,未列入的旧片段保留', () => {
    const next = applyConditionPatch('手臂受伤,夹板固定；自述还需休养几天；左腿擦伤', {
      replace: [{ id: 'c2', text: '休养结束,可正常活动' }],
    });
    expect(next).toBe('手臂受伤,夹板固定；休养结束,可正常活动；左腿擦伤');
  });

  it('replace 空串删除该片段,add 追加尾部', () => {
    const next = applyConditionPatch('手臂受伤；左腿擦伤', {
      replace: [{ id: 'c1', text: '' }],
      add: [{ text: '新扭伤脚踝' }],
    });
    expect(next).toBe('左腿擦伤；新扭伤脚踝');
  });

  it('全部片段清空后返回 undefined', () => {
    expect(applyConditionPatch('手臂受伤', { replace: [{ id: 'c1', text: '' }] })).toBeUndefined();
  });
});

describe('conditionPatch 经重放生效', () => {
  it('主角已有伤情时按编号局部更新,不整段覆盖', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: '手臂受伤,夹板固定；自述还需休养几天' } }),
      message({ protagonist: { conditionPatch: { replace: [{ id: 'c2', text: '休养结束,可正常活动' }] } } }),
    ];
    const derived = deriveMemory(chat);
    expect(derived.protagonist.condition).toBe('手臂受伤,夹板固定；休养结束,可正常活动');
  });

  it('NPC 已有伤情时局部更新,并保留其他角色限制', () => {
    const chat: STMessage[] = [
      message({ npcs: { add: [{ name: '艾琳', condition: '左肩中箭；不能拉弓' }] } }),
      message({ npcs: { update: [{ name: '艾琳', conditionPatch: { replace: [{ id: 'c2', text: '已能轻微拉弓' }] } }] } }),
    ];
    const derived = deriveMemory(chat);
    const npc = derived.npcs.find(n => n.name === '艾琳');
    expect(npc?.condition).toBe('左肩中箭；已能轻微拉弓');
  });
});

describe('locationEvidence 校验(仅内置模板启用)', () => {
  const npcLoc = (extra: Record<string, unknown>) =>
    ({ npcs: { update: [{ name: '艾琳', location: '钟楼', ...extra }] } } as never);
  const content = '夜里,她走进钟楼,风很大。';

  it('证据命中本轮正文 → 保留定位', () => {
    const out = finalizeDelta(npcLoc({ locationEvidence: '她走进钟楼' }), [], [], { content, enforce: true });
    expect(out.npcs?.update?.[0].location).toBe('钟楼');
  });

  it('缺证据 → 丢弃定位', () => {
    const out = finalizeDelta(npcLoc({}), [], [], { content, enforce: true });
    expect(out.npcs?.update?.[0].location).toBeUndefined();
  });

  it('证据不在本轮正文 → 丢弃定位', () => {
    const out = finalizeDelta(npcLoc({ locationEvidence: '她在码头' }), [], [], { content, enforce: true });
    expect(out.npcs?.update?.[0].location).toBeUndefined();
  });

  it('自定义模板(enforce=false)→ 不校验,保留旧行为', () => {
    const out = finalizeDelta(npcLoc({}), [], [], { content, enforce: false });
    expect(out.npcs?.update?.[0].location).toBe('钟楼');
  });

  it('空 location(去向不明)→ 不需证据,直接清除', () => {
    const out = finalizeDelta({ npcs: { update: [{ name: '艾琳', location: '' }] } } as never, [], [], { content, enforce: true });
    expect(out.npcs?.update?.[0].location).toBe('');
  });
});

describe('plans.update', () => {
  it('finalizeDelta 把短序号翻译成稳定 id', () => {
    const out = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/5' }] } } as never,
      [{ id: 'plan:leaf#0' }],
    );
    expect(out.plans?.update).toEqual([{ id: 'plan:leaf#0', targetTime: '1988/10/5' }]);
  });

  it('显式 locationPath: [] 清除旧锚点,不继承旧归属', () => {
    const out = finalizeDelta({ location: 'in transit', locationPath: [] } as never, []);
    expect(out.locationPath).toEqual([]);
  });

  it('改期后覆盖 targetTime,旧 content 保留', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: '三日后决斗', targetTime: '1988/10/1' }] } });
    const opened = deriveMemory([first]).plans;
    const finalized = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/9' }] } } as never,
      opened,
    );
    const derived = deriveMemory([first, message(finalized)]);
    expect(derived.plans[0].targetTime).toBe('1988/10/9');
    expect(derived.plans[0].content).toBe('三日后决斗');
  });
});
