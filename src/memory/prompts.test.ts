import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  buildBatchSummaryPrompt,
  buildBatchThinking,
  buildCharCardSystem,
  buildPersonaSystem,
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  buildWorldInfoSystem,
  CONDITION_PATCH_PROTOCOL,
  JAILBREAK_PROMPT,
  isBuiltinSummaryPrompt,
  LEDGER_PROTOCOL,
  MEMORY_BRIEFING_END,
  MEMORY_BRIEFING_NOTE,
  NPC_LOCATION_EVIDENCE_PROTOCOL,
  QUERY_REWRITE_SYSTEM,
  QUERY_REWRITE_TAIL,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
  RESUMMARY_THINKING_CHECKLIST,
  SUMMARY_MACROS,
  SUMMARY_OUTPUT_PROTOCOL,
  SUMMARY_PROMPT,
  THINKING_CHECKLIST,
} from './prompts';
import { START_TAG, TIME_TAG_PROMPT } from './timeTag';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';

const originalPrompts = { ...apiSettings.prompts };
const originalVerbosity = apiSettings.verbosity;

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
});

const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User',
  char: 'Character',
  time: '2026/9/8 10:00',
  location: 'School',
  protagonist: {},
  sceneFocus: null,
  lifeDetails: [],
  items: [],
  itemLog: [],
  scenes: [],
  npcs: [],
  openPlans: [],
  resolvedPlans: [],
  history: 'Earlier events.',
  content: 'The current passage.',
  hasTimeTags: true,
  varsState: {},
  varsMeaning: '',
  varsRule: '',
};

function combined(parts: ReturnType<typeof buildSummaryPrompt>): string {
  return `${parts.system}\n\n${parts.user}`;
}

describe('new built-in prompts', () => {
  it('ships the fact-preservation rules (核心集中在破限,正文不再重复携带)', () => {
    const parts = buildSummaryPrompt(args);
    const system = parts.system;
    // NVWA 核心应集中在 JAILBREAK_PROMPT(占独立 system 位),不再出现在正文里
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(system).not.toContain('<nvwa_standalone_core>');
    expect(system).toContain('【物品规则】(items 字段,严格筛选)');
    expect(system).toContain('【NPC 规则】(npcs 字段,极严筛选)');
    expect(system).toContain('【计划/悬念规则】(plans 字段)');
    expect(system).toContain('【场景/地点规则】(scenes 字段,默认不记)');
    expect(system).toContain('【摘要成文顺序】');
    expect(system).toContain('【空间事实边界】');
    expect(system).toContain('【摘要时间语言铁律】');
    expect(system).toContain('【摘要撰写规则】(summary 字段,必填)');
    // 新协议:伤情局部更新由代码动态注入
    expect(system).toContain('【伤情局部更新协议】');
    expect(system).toContain('conditionPatch');
    expect(CONDITION_PATCH_PROTOCOL).toContain('未列入 replace 的旧片段由程序原样保留');
    expect(CONDITION_PATCH_PROTOCOL).toContain('编号仅本请求有效');
    expect(NPC_LOCATION_EVIDENCE_PROTOCOL).toContain('locationEvidence');
    expect(LEDGER_PROTOCOL).toContain('bbs_items');
  });

  it('keeps the material in user and the rules in system, with all macros expanded', () => {
    const parts = buildSummaryPrompt({
      ...args,
      protagonist: { identity: 'PROFILE_SENTINEL' },
      history: 'HISTORY_SENTINEL',
      varsState: { value: 'VARIABLE_SENTINEL' },
      varsMeaning: 'MEANING_SENTINEL',
      varsRule: 'VARIABLE_RULE_SENTINEL',
      content: 'BODY_SENTINEL',
    });
    const thinking = buildSummaryThinking(args.user);
    for (const sentinel of ['PROFILE_SENTINEL', 'HISTORY_SENTINEL', 'VARIABLE_SENTINEL', 'MEANING_SENTINEL', 'VARIABLE_RULE_SENTINEL', 'BODY_SENTINEL']) {
      expect(parts.user).toContain(sentinel);
      expect(parts.system + thinking).not.toContain(sentinel);
    }
    expect(parts.user).toContain('【本轮对话】');
    for (const text of [parts.system, parts.user, thinking]) {
      expect(text).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('fills the summary word range and the character cap per verbosity', () => {
    for (const verbosity of ['detailed', 'concise'] as const) {
      apiSettings.verbosity = verbosity;
      const prompt = combined(buildSummaryPrompt(args));
      expect(prompt).toContain(verbosity === 'detailed' ? '150-300' : '80-150');
      expect(prompt).toContain(verbosity === 'detailed' ? '360' : '180');
    }
    expect(SUMMARY_MACROS.map(m => m.token)).toContain('{{summary_max_chars}}');
  });

  it('keeps custom templates in user with the compatibility supplements in system', () => {
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{protagonist_block}}';
    const parts = buildSummaryPrompt({ ...args, protagonist: { identity: 'CUSTOM_PROFILE' } });
    expect(parts.user).toContain(`CUSTOM ${args.content}`);
    expect(parts.user).toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain(args.content);
    expect(parts.system).toContain('【柏宝书主角档案兼容协议】');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('isBuiltinSummaryPrompt 区分内置/自定义,作为解析校验开关', () => {
    expect(isBuiltinSummaryPrompt()).toBe(true);
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT });
    expect(isBuiltinSummaryPrompt()).toBe(true);
    apiSettings.prompts.summary = '自定义 {{content}}';
    expect(isBuiltinSummaryPrompt()).toBe(false);
  });

  it('sends the current output protocol in the checklist, not the schema system block', () => {
    const parts = buildSummaryPrompt(args);
    expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain('【输出前核查】');
    expect(THINKING_CHECKLIST).toContain('conditionPatch');
    expect(buildSummaryThinking(args.user)).toContain(args.user);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('根键只有 summary');
  });

  it('treats a saved exact default as built-in while keeping the editor copy complete', () => {
    const before = [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ];
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT, resummary: RESUMMARY_PROMPT, resummary2: RESUMMARY2_PROMPT });
    expect([
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]).toEqual(before);
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(template).toContain('{{content}}');
      expect(template).toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
  });
});

describe('batch and compression prompts', () => {
  it('keeps batch floor boundaries, count macros and the summary-only protocol', () => {
    const parts = buildBatchSummaryPrompt({ ...args, floorCount: 3 });
    const prompt = combined(parts);
    const thinking = buildBatchThinking(3);
    expect(thinking).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(thinking).toContain('这批共 3 楼');
    expect(thinking).toContain('每个元素只含 n / summary / timeStart / timeEnd');
    expect(thinking).toContain('现代/数字日期的两端都必须包含完整年份');
    expect(parts.system).toContain('长度必须等于 3');
    expect(parts.user).toContain(args.content);
    expect(parts.system).not.toContain(args.content);
    expect(prompt + thinking).not.toMatch(/\{\{\w+\}\}/);
  });

  it('emits the compression schema with budgets and keeps sources in user', () => {
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.system).toContain('{ "summary":');
      expect(parts.user).toContain('x'.repeat(1000));
      expect(parts.system).not.toContain('x'.repeat(1000));
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
      expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
    expect(combined(buildResummaryPrompt({ ...args, level: 1 }))).toContain('【关系线保留】');
    expect(combined(buildResummaryPrompt({ ...args, level: 2 }))).toContain('【事实证据边界(最高优先级)】');
  });

  it('keeps custom compression text in user and supplements in system', () => {
    apiSettings.prompts.resummary = 'CUSTOM L1 {{content}} {{resummary_words}}';
    apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}} {{target_min}} {{target_max}} {{target}}';
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.user).toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).not.toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).toContain('【关系线保留】');
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});

describe('jailbreak, briefing and query rewrite', () => {
  it('replaces the old override with the bare NVWA core (no task note)', () => {
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(JAILBREAK_PROMPT).not.toContain('【记忆整理任务说明】');
    expect(JAILBREAK_PROMPT).not.toContain('sanctuary_override_directive');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_NOTE).toContain('不要输出简报的标签');
    expect(MEMORY_BRIEFING_END).toContain('不是上限');
    expect(MEMORY_BRIEFING_END).toContain('最后确认的位置不保证仍然有效');
    expect(MEMORY_BRIEFING_END).toContain('不要模仿压缩记录的句式');
  });

  it('资料包装与 09 原文逐字一致(仅把占位换成实际资料)', () => {
    const section = (placeholder: string, sentinel: string) =>
      dataWrappersRaw
        .replace(placeholder, sentinel)
        .split(/\n\s*\n(?=【)/)
        .find(b => b.includes(sentinel))!
        .trim();
    expect(buildPersonaSystem('SENT')).toBe(section('〔主角设定占位〕', 'SENT'));
    expect(buildWorldInfoSystem('SENT')).toBe(section('〔世界书内容占位〕', 'SENT'));
    expect(buildCharCardSystem('SENT')).toBe(section('〔角色卡内容占位〕', 'SENT'));
  });

  it('keeps the original 5-query rewrite prompt (复刻 Horae 的用户优化版)', () => {
    expect(QUERY_REWRITE_SYSTEM).toContain('你是角色扮演续写场景中的上下文规划器');
    // 原版要求“固定生成5条查询”——多路召回 + RRF 融合靠的就是这 5 条覆盖面
    expect(QUERY_REWRITE_SYSTEM).toContain('固定生成5条查询');
    expect(QUERY_REWRITE_SYSTEM).toContain('INTENT');
    expect(QUERY_REWRITE_SYSTEM).toContain('示例1:');
    expect(QUERY_REWRITE_TAIL).toContain('恰好5行Q');
    expect(QUERY_REWRITE_TAIL).toContain('INTENT');
  });

  it('keeps the time-tag prompt on the anchor-initialising behaviour without the NVWA core', () => {
    expect(TIME_TAG_PROMPT).not.toContain('<nvwa_standalone_core>');
    expect(TIME_TAG_PROMPT).toContain('【时间锚点要求(系统强制)】');
    expect(TIME_TAG_PROMPT).toContain(`<${START_TAG}>`);
    expect(TIME_TAG_PROMPT).toContain('请你自行设定一个符合本世界观的具体起始时刻');
    expect(TIME_TAG_PROMPT).toContain('这是为记忆系统建立时间锚点所必需的合理设定,不算编造');
    expect(TIME_TAG_PROMPT).toContain('bbs_items');
  });
});
