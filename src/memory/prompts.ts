/**
 * 提示词模板。
 *
 * 设计要点(相对 Horae 原版的改进):
 *  1. 输出 JSON 而非纯文本,便于结构化抽取与增量更新。
 *  2. 明确区分两类语义:
 *     - 覆盖型(time/location):写当前最新值,代码直接替换。
 *     - 指令型(items/plans):只给「变化」,代码增量施加,省 token 且不易篡改全量。
 *  3. 把「当前状态」(现有物品名、未了结的计划/悬念并编号)注入提示词,
 *     模型才能正确决定 add/remove/update/resolve。
 *  4. 保留 Horae 的优点:时间锚定、具象化、保留专有名词、正文不含 markdown。
 *
 * 占位符:{{user}} {{char}} {{state_time}} {{state_location}}
 *         {{protagonist_block}} {{items_block}} {{plans_block}} {{content}}
 */

import { apiSettings, type Verbosity } from '@/api/settings';
import { fmtConditionFragments } from './conditionPatch';
import { fmtLifeDetail } from './lifeDetails';
import { fmtNpcSummaryList, NPC_AFFINITY_FIELDS, type NpcSummaryView } from './npcRelations';
import { RULE_COMPLETE_TIME_ANCHOR } from './timeTag';
// 新提示词正文以原版文本文件为准(?raw 内联,可原样保留排版与标签)。
import summaryRaw from './prompts/summary.txt?raw';
import resummaryRaw from './prompts/resummary.txt?raw';
import resummary2Raw from './prompts/resummary2.txt?raw';
import tasksRaw from './prompts/tasks.txt?raw';
import builtinProtocolsRaw from './prompts/builtin-protocols.txt?raw';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';
import type { ItemLogEntry, JsonValue, MemLifeDetail, MemPlan, MemProtagonist, PlanOutcome, SceneFocus } from './types';

/** 按「===== NAME =====」分节解析协议文件(08)。 */
function protocolSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^=====\s*(.+?)\s*=====\s*$/gm;
  const marks: { name: string; headerStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) marks.push({ name: m[1].trim(), headerStart: m.index, contentStart: re.lastIndex });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].headerStart : raw.length;
    out[mark.name] = raw.slice(mark.contentStart, end).trim();
  });
  return out;
}
const PROTOCOLS = protocolSections(builtinProtocolsRaw);
/** 取以 prefix 开头的分节(节名可能带括号说明)。 */
function protocolSection(prefix: string): string {
  const key = Object.keys(PROTOCOLS).find(k => k.startsWith(prefix));
  return key ? PROTOCOLS[key] : '';
}
/** 拆出「规则 / 材料 / 输出协议」三段:材料从 `【主角】{{user}}` 开始,协议从 `【检查记录与最终结果输出协议】` 开始。 */
function splitPrompt(raw: string): { rules: string; input: string; protocol: string } {
  const i = raw.indexOf('【主角】{{user}}');
  const j = raw.indexOf('【检查记录与最终结果输出协议】', i >= 0 ? i : 0);
  return {
    rules: (i >= 0 ? raw.slice(0, i) : raw).trim(),
    input: (i >= 0 ? raw.slice(i, j >= 0 ? j : undefined) : '').trim(),
    protocol: (j >= 0 ? raw.slice(j) : '').trim(),
  };
}
/** 去掉 NVWA 核心,只留任务说明部分。 */
function afterStandaloneCore(raw: string): string {
  const tag = '</nvwa_standalone_core>';
  const i = raw.indexOf(tag);
  return (i >= 0 ? raw.slice(i + tag.length) : raw).trim();
}
/** 去掉独立核心:核心统一放在「破限」位(JAILBREAK_PROMPT)。
 *  正文提示词不再重复携带,避免同一请求里核心出现两次、也避免看起来「破限被拆散」。 */
const SUMMARY_BODY = afterStandaloneCore(summaryRaw);
const RESUMMARY_BODY = afterStandaloneCore(resummaryRaw);
const RESUMMARY2_BODY = afterStandaloneCore(resummary2Raw);

const SUMMARY_SPLIT = splitPrompt(SUMMARY_BODY);
const RESUMMARY_SPLIT = splitPrompt(RESUMMARY_BODY);
const RESUMMARY2_SPLIT = splitPrompt(RESUMMARY2_BODY);

/** 伤情局部更新协议(08 内置;片段编号由请求动态附加)。 */
export const CONDITION_PATCH_PROTOCOL = protocolSection('CONDITION_PATCH_PROTOCOL');
/** NPC 定位证据协议(08 内置)。 */
export const NPC_LOCATION_EVIDENCE_PROTOCOL = protocolSection('NPC_LOCATION_EVIDENCE_PROTOCOL');
/** 旁注读取协议(注入主对话,提醒主模型不要复写 <bbs_items>/<bbs_vars>)。 */
export const LEDGER_PROTOCOL = protocolSection('LEDGER_PROTOCOL');

/** 一个可用占位符(宏):token 用于插入,desc 给用户看「这里会替换成什么」。 */
export interface PromptMacro {
  token: string;
  desc: string;
}

/** 摘要提示词可用的宏(供设置页展示 + 点击插入) */
export const SUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{history_block}}', desc: '本轮之前的历史剧情摘要' },
  { token: '{{state_time}}', desc: '当前已知时间' },
  { token: '{{state_location}}', desc: '当前已知地点' },
  { token: '{{protagonist_block}}', desc: '主角当前客观档案' },
  { token: '{{items_block}}', desc: '现有物品清单' },
  { token: '{{itemlog_block}}', desc: '近期物品变动(已结算的账)' },
  { token: '{{scenes_block}}', desc: '已知地点清单(避免重复记录)' },
  { token: '{{npcs_block}}', desc: '已登场的 NPC 名册(避免重复记录)' },
  { token: '{{plans_block}}', desc: '未了结的计划/悬念' },
  { token: '{{resolved_plans_block}}', desc: '近期已了结的计划/悬念(含了结方式/原因,防重复记录)' },
  { token: '{{scenefocus_block}}', desc: '本轮在场/即时场景与未完成动作(按需更新)' },
  { token: '{{vars_state_block}}', desc: '自定义变量当前状态 + 含义 + 变化规则(未配置时为空)' },
  { token: '{{varlog_block}}', desc: '变量含义 + 变化规则(合并)' },
  { token: '{{content}}', desc: '本轮待摘要的对话正文' },
  { token: '{{summary_words}}', desc: '摘要目标字数范围(随详细/精简档位变化)' },
  { token: '{{summary_max_chars}}', desc: '摘要字符上限(硬上限,随档位变化)' },
];

/** 总结(压缩)提示词可用的宏 */
export const RESUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{content}}', desc: '待融合的多条摘要正文' },
  { token: '{{resummary_words}}', desc: '总结目标字数范围(随详细/精简档位变化)' },
];

/** 二次总结提示词可用的宏(动态字数区间随详细/精简档位变化) */
export const RESUMMARY2_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{content}}', desc: '待融合的多条上层总结正文' },
  { token: '{{target_min}}', desc: '最低字数(详细为输入的 40%,精简为 30%)' },
  { token: '{{target_max}}', desc: '最高字数(详细为输入的 50%,精简为 40%)' },
  { token: '{{target}}', desc: '兼容旧自定义模板:等同于最高字数 {{target_max}}' },
];

/**
 * 记忆注入块的「私密简报」框定语:贴在每个注入回主对话的记忆块开头。
 * 为何需要:[当前状态]/[历史剧情摘要]/[相关回忆] 长得像数据面板,主模型容易误以为是
 * 要它填写/复述的模板,于是在正文后跟着输出一份状态快照。这句明确「只读、仅你可见、
 * 严禁复述」,把它们框定为幕后背景而非待输出内容。(时间标签提示词是真要模型输出标签的
 * 指令,不套这层框定。)
 */
export const MEMORY_BRIEFING_NOTE = protocolSection('MEMORY_BRIEFING_NOTE');

/**
 * 简报收尾:与 NOTE 首尾包裹,把记忆块明确「封口」,避免主模型把后续正文也当成简报的一部分续写。
 * 末句给正向引导——不只是「别复述」的禁令,而是「像已读过前情的叙述者那样自然续写」,告诉模型
 * 简报的用途是「我已知道这些」,正文里自然体现即可。
 */
export const MEMORY_BRIEFING_END = protocolSection('MEMORY_BRIEFING_END');

/* ============ 共享规则段:单楼摘要与批量摘要复用同一套规则,单一来源避免分叉 ============ */

/** 长期数据库原则:什么该写进结构化字段、什么只进 summary。 */
export const RULE_LONGTERM_DB = `【长期数据库原则(极度重要)】
summary 用于记录本回合发生的剧情;除此之外的字段(items、plans 等)属于长期状态数据库。
只有未来数十章后仍值得保留、会影响后续剧情生成的信息才能写入这些字段。
凡是本回合动作、普通对话、临时状态、一次性事件、普通日常,或 summary 已能完整表达的信息,一律禁止写入其它字段。
拿不准时,宁可不写,也不要猜测或记录价值不高的信息。`;

/** 物品规则(items 字段)。 */
export const RULE_ITEMS = `═══ 【物品规则】(items 字段,严格筛选) ═══
默认不记。只有同时满足下列三条才记,缺一即弃:
  ✓ 角色主动获取并有意保留(买、捡、收到、偷、制作)
  ✓ 对剧情有意义(可交易/可使用/有情感价值/是线索/是武器装备)
  ✓ 角色会带走或专门存放的东西
以上三条已能排除绝大多数环境道具、日常用品、固定家具、普通食物饮料——这些都不满足"主动获取并保留有意义之物",无需逐一枚举。额外注意:
  ✗ 正在穿戴的服装、普通食物饮料(除非是关键道具/毒药/特殊料理)默认不记。当前穿着属于「即时状态」:{{user}} 写 protagonist.outfit,NPC 写对应的 npcs.outfit,不要当物品。
【消耗品处理】
  ✦ 用完/喝完/吃完 → 用 remove 删除整个物品,禁止改成"空瓶""空盒"。
  ✦ 部分消耗 → 用 update 更新数量。
  ✦ 普通容器随内容物一起删除;特殊容器(魔法瓶、名贵盒子)才单独记录。
【状态一致性】
  ✦ 物品状态只能因本回合明确描写的事件改变。
  ✦ 本回合未提及的物品 → 不写任何 items 指令,保持参考状态不变。
  ✦ 禁止脑补物品"恢复""补充""自动出现"。
【严禁重复结算(重要)】上方【现有物品】是结算到此刻的当前快照,【近期物品变动】是已经记过账的历史。
  ✦ 这些变动都已生效、已反映在现有数量里,绝不能再补一次。
  ✦ 只有正文里**新发生**的获取/消耗/损坏才写 items 指令。
  ✦ 典型陷阱:上一段已把"解药 3→2",本段正文若没有再次饮用的明文描写,就保持 2,禁止再 update 成 1。
  ✦ 拿不准某次消耗是否已结算 → 对照【近期物品变动】,已在其中即视为已结算,不再处理。
【匹配】update/remove 必须用上方【现有物品】里的原名精确匹配。
【随身 / 存放地点(carried / location)】用于省 token:只有"随身"或"在当前所在地"的物品才会发给后续剧情,存在别处的暂不展开。
  ✦ 默认随身:角色拿在身上、随身携带的物品,carried 省略即可(等于随身),不必写 location。
  ✦ 明确寄存:物品被**明确留在某地点**(放回家中、存进宝库、藏在树洞、寄存柜台)→ 写 carried:false 且 location 填那个地点。
  ✦ location 命名务必复用上方【当前地点】或正文里出现的地名原文(如当前在"城西客栈"就写"城西客栈"),不要另造叫法,否则系统无法判断物品是否在身边。
  ✦ 移动物品:角色把存放的东西取回随身 → update 该物品 carried:true;把随身的东西放下/寄存某处 → update carried:false + location。角色仅仅移动位置、没动具体物品时,不要改物品的 carried/location。
  ✦ 寄存物品转移(A→B):某件**已寄存**的物品被从一处挪到另一处(仍非随身,如宝箱从地窖搬上马车、解药从甲房移到乙房,或被他人带去别处)→ update 该物品 location 改成**新地点**(carried 仍为 false)。物品换了地方却不更新 location,系统会一直以为它在旧处——这是常见漏更新点,务必盘到。
  ✦ 拿不准是否寄存 → 默认随身(不写 carried/location),宁可随身也不要凭空安排一个存放地。`;

/** 场景/地点规则(scenes 字段)。 */
export const RULE_SCENES = `═══ 【场景/地点规则】(scenes 字段,默认不记) ═══
只记录**有名字、角色实际到达、且你能写出具体描述**的地点;路过、无名、临时的场所不记。
【描述必填(铁律)】每个记录的地点都必须能写出一句具体、客观的描述(它是什么、关键特征/与剧情相关的要素)。
  ✦ 写不出有意义描述的地点 = 没有记录价值,直接不记。这条同时用来过滤过于宽泛的背景:
    「国家/星球/宇宙」这类大尺度容器,除非剧情真的在该尺度上发生了事、且你能据此写出具体描述,否则一律不记。
  ✦ 判据不是"尺度大小",而是"剧情是否真的在那个尺度上发生事":市井故事记到城市/街区就够;星际故事星球才有意义。禁止凭空往上堆空泛层级。
  ✦ desc 简短客观(一两句),禁止文学修饰与脑补。
  ✦ 持续性须有依据:当次观察、实时读数、短暂在场或一次遭遇不能改写为地点的长期属性。确需记入的临时事实须限定为本次所见;普通临时状态留在 summary/sceneFocus,不能为满足 desc 必填而编造恒常特征。
【何时更新描述(update)】只在以下两种情况更新,普通路过/重访不更新:
  ✦ 地点本身发生了**实质变化**(被烧毁/改建/易主/新增显著设施等)。
  ✦ 此处发生了**值得记入档案的关键事件**,使这地点的意义改变(如初遇之地后来又成了分手之地、定情之处、命案现场)。
  ✦ ⚠️ update 是**整体覆盖**desc,不是追加!必须写出**累积后的完整描述**——保留原有要点,再把新信息并进去。
    例:咖啡馆原 desc「男女主初遇的地方」,后来在此分手 → update 写「男女主初遇、也是后来分手的地方」(而非只写「分手的地方」,否则初遇信息会丢失)。
  ✦ 只是又来了一次、没有新变化或新事件 → 不要 update。
【路径】path 是**完整地理路径,由粗到细**的数组,例:["王都","城西区","归雁客栈"]。
  ✦ 系统按路径逐级建立嵌套。**为路径上每个你新引入的层级各写一条带 desc 的 add**(如首次到客栈,城西区也首次出现,就 add 两条:城西区、归雁客栈),让每级都有描述。
  ✦ 路径段用故事内专有地名原文,不要用「这里」「某地」等代词。
【复用已有,严禁重复】上方【已知地点】是带层级的已记录地点树。
  ✦ 同一地点务必复用既有路径与命名(连层级写法都对齐),不要换个叫法再记一遍。
  ✦ 仅当**首次出现**或**描述有实质更新**时才写 scenes;否则不输出 scenes。
【补全层级 / 加父级(reparent)】当你发现一个**已记录**的地点其实从属于另一个地点时,用 reparent 把它(连同其下属)挂到正确的上级,而**不是**新建一个平行的顶级地点。
  ✦ 典型:开篇只记了"家"(顶级);后来角色出门到"翠湖小区",你知道家就在这小区里 → reparent 把"家"挂到"翠湖小区"下。
  ✦ 也能在已有父子之间**插入中间层**:已知"城西区 > 归雁客栈",发现两者间还隔着"商业街" → 对"归雁客栈"做 reparent,newPath = ["城西区","商业街","归雁客栈"]。
  ✦ reparent 字段:node = 该地点**当前**的完整路径;newPath = 它**应在**的完整新路径(末段通常同名);descs = newPath 上新出现层级的描述(同样必填,写不出描述就别引入这一级)。
【当前所在】场景只负责「地点档案」;角色当前在哪由 location 字段(覆盖型)单独表达,二者各司其职。
  ✦ location 是自由文字、可任意细(屋内/门口/窗边),用于展示当前位置。
  ✦ locationPath 是 location 对应到【已知地点】树里的**那个节点的完整路径**(由粗到细),作精确定位锚点 —— 物品/NPC 的「是否在身边」全靠它判断。
  ✦ location 写得比任何已记录节点都细时(如「302室屋内」而树里只到「302室」),locationPath 就给到**能对上的那一级**(["...","302室"]);location 与某节点同名时,locationPath 就指向它。改了 location 务必同步给 locationPath。`;

/** 用户操控主角的客观当前档案规则。 */
export const RULE_PROTAGONIST = `═══ 【主角当前档案规则】(protagonist 字段,覆盖型) ═══
这是 {{user}} 本人的当前客观档案,与 NPC 名册分开。只在【本轮对话】明确揭示或改变了会影响后续续写的信息时输出:
  ✦ gender:明确的性别/性别表现。
  ✦ age:年龄。**在正文明确提到时写**(档案里还没有→补填;已有→仅明确纠正/变化才写),写正文原话的值(如「25」「二十出头」),**不要自己按时间流逝换算**——系统会记录此刻的故事时间作锚点,以后随剧情时间自动推算,你反复输出反而会把锚点刷乱。
  ✦ identity:当前身份、职业、种族、公开地位;发生变化时写变化后的完整当前值。
  ✦ appearance:当前稳定外貌/身体特征,如发色、体型、永久伤疤、变身后的身体;普通表情和短暂姿势不记。
  ✦ outfit:当前完整着装;换装、衣物破损/染血/打湿后覆盖刷新。
  ✦ condition:当前身体状态/健康,如受伤、中毒、疲惫、醉酒;痊愈或恢复正常时输出空字符串 "" 清除旧状态。
【严格边界】
  ✦ protagonist 是覆盖型当前快照,不沉淀历史;其中 outfit/condition 与当前时间、地点同类,发生明确变化时应及时刷新,不受上方长期数据库门槛限制。
  ✦ 只记正文明确事实。不要根据 {{user}} 的台词或选择推断性格、癖好、价值观、情绪和内心,不要替用户定义人格。
  ✦ 上方【主角设定/persona】只是理解背景,不是本轮新增事实;禁止把整份 persona 抄进 protagonist。
  ✦ 地点由 location/locationPath 记录,物品由 items 记录,不要在 protagonist 里重复。
  ✦ 字段省略=保持旧值;空字符串=明确清空旧值。没有客观变化就不要输出 protagonist。`;

/** 只对 NPC 好感字段开放估算,不放宽事实摘要/关系/主角档案的证据边界。 */
export const RULE_NPC_AFFINITY = `═══ 【内心好感与外在态度规则】(NPC 对 {{user}} 的稳定倾向估计) ═══
【有限估算例外】仅 npcs.add/update 的 affinityInner、affinityOuter、affinityNote 允许结合已知人设、此前状态和本轮剧情自动估算;其他字段和 summary 仍只记有依据的事实。估计不是已证实的内心,不得把它抄入 summary/relation/ties/personality 或据此确认关系、伏笔、动机。
【五档,不是分数】两侧各自只接受整数 -2、-1、0、1、2,含义如下:
${NPC_AFFINITY_FIELDS.map(f => `  ${f.label}(${f.key}):${f.options.filter(o => o.value !== '').map(o => `${o.value}=${o.label}`).join(';')}`).join('\n')}
  内心好感=对 {{user}} 的真实好恶/在意与亲近倾向;外在态度=对 {{user}} 相对稳定的对待方式(不是对所有人的态度),不是本轮一句话的语气或心情。两者都不等于爱情、信任、服从或同意。爱恨交织不能正负抵消成中性,矛盾写在说明中。
【未知与补丁】尚无依据的一侧保持未知,不要默认填 0。首次有足够依据时可单独初始化任一侧;其余时候省略字段=沿用旧值,null=明确撤回不可靠估计并恢复未知。旧记录没有字段也不要求补齐。档位是绝对状态,禁止增量、百分制、小数或暗中累计分数。
【默认保持,跨档才更新】从旧档位出发,不是每轮重新打分。只有新剧情足以说明旧档位不再合适才改:持续清晰的新倾向、重要触发事件或对旧判断的明确纠正。变化越大,依据须越充分;重大转折可跨档,没有固定每轮增减幅度。没有变化就完全省略好感字段,不能为了完成盘点强行制造变动。
  普通夸奖、送礼、亲密举动、拌嘴、一次冷脸或开心通常不跨档;一时情绪写 summary/sceneFocus 的明确事实,不要改写长期感情。小事件可构成发展过程,但不能每次结算;旧摘要复述、聊天轮数、时间流逝、旧档位本身都不是再次变化的证据。
【内外完全独立】分别判断有无变化、方向与幅度;内变外不变、外变内不变、反向变化、两者都不变均可。不预设内慢外快,不设联动、自动追平或固定人格增长系数;表里如一也不强制绑定。人设影响他在意什么及如何表达,不是见到“傲娇/虚伪”就自动套档位。仅凭客套或嘴硬不能确认内在;要结合行动、上下文与已知设定,证据不足则不改。
【说明也要稳定】affinityNote 是一句简短的依据/表现/矛盾说明,不是内心独白或新增剧情。同档默认沿用旧措辞,禁止每轮升级修辞来暗中加深感情;只有跨档或依据、表现机制、旧判断确有实质变化时才更新。只改一侧时说明仍须与另一侧的既有状态相容。空字符串可明确清空错误说明。后来揭示一直在伪装,是修正旧估计,不要记成这时突然变心。
【输出示例】若原内=1、外=-1,本轮重要事件支持内在升到2而仍掩饰,只写 {"name":"原角色名","affinityInner":2,"affinityNote":"估计更加在意,仍以冷淡掩饰关心"};外在不重复写。若只是普通互动,两侧与说明均省略。
【分工与视角】relation 保留关系称谓与可观察立场,ties 保留长期人际结构;内置好感不写入自定义变量,不要据此新建或同步同名变量(用户已有变量仅按其原规则独立处理)。内在估计不代表主角或其他角色知情,不可让人读心、揭穿秘密或自动表白。`;

/** NPC 规则(npcs 字段)。 */
export const RULE_NPCS = `═══ 【NPC 规则】(npcs 字段,极严筛选) ═══
{{user}} 本人不放进 NPC 名册;其变化写入 protagonist。NPC **默认不记**,门槛比物品更高 —— 宁可漏记,也绝不滥记;绝大多数楼层不产生任何 npcs.add。
━━ 准入硬门槛(必须满足其一,否则一律不记) ━━
  ① 该角色与 {{user}} 发生过**直接、具体且有剧情意义的互动**:有来有往的对话、冲突对抗、交易、结伴同行、情感往来、给予关键信息/物品等。一次性的服务性接触(点菜、问路、买东西、检票)**不算**互动。
  ② 或:虽暂未露面,但被剧情**反复指涉、明显重要**的关键人物(如尚未现身的幕后主使、被反复提及的传说人物)。
【反例 —— 一律不记(哪怕 AI 顺手给了名字)】店小二、跑堂、车夫船夫、摊贩商贩、路人甲乙、围观群众、群演、报幕/通报/喊话者、只露一面就消失的功能性角色、仅被瞥见或一笔带过的人。这些都不满足"与主角直接且有意义地互动"。
【判据】问两句:"主角和这人之间发生了具体的、对剧情有影响的事吗?""这人离开后,后续剧情还会需要记得他是谁吗?"——两句都明确为"是"才记;只要一句拿不准 → **不记**。
【字段】每个 NPC 可带档案层、即时层及独立的好感估计,更新门槛不同:
  ┃ 档案层(他是谁/长什么样,长期不变,高门槛,几乎不更新):
  ✦ gender:**性别**(短值,如「男」「女」)——记一次即可。**极重要**:性别在所有分档都注入(包括不在场),防你在后续剧情搞错该角色性别。首次记录时务必填,除非正文确实未透露。
  ✦ age:**年龄**——在正文**明确**提到时记(自报、被介绍、文档写明),写正文原话的值(「25」「二十出头」都行):名册里还没有年龄 → 补填;已有年龄 → 仅正文明确纠正/变化(过生日、改龄)才 update。**绝不要按时间流逝自己换算年龄**:系统会记下此刻的故事时间作锚点、以后随剧情时间自动推算;你若隔三差五重写一遍,反而把锚点刷乱。正文没提就不填,禁止按外貌猜。
  ✦ relation:**与主角({{user}})的关系**(覆盖型)——格式「称谓,一句态度/立场」,**称谓写在最前**(如「主角的师姐,明面冷淡暗中维护」)。首次记录互动角色时尽量填。
    【质变的证据门槛(极重要)】update relation 只认三种证据:人物**明确说出**(公开断绝、当面告白定情)、双方**明确约定**(结盟、拜师、成婚),或**无歧义的客观事件**(一方杀了对方至亲、正式退婚)。
    ✗ 单次争吵、冷战、赌气离开、一次亲密举动、送礼、照顾、短暂分离,**都不构成质变**——relation 保持不动,把事件写进 summary 即可。典型错误:「吵了一架」写成「已彻底决裂」、「和好前先写了『已和好』」——**严禁**。
    ✗ 态度半句只写可观察事实(「近日因 X 事争吵,表面冷淡」),不下心理结论(「深爱」「恨之入骨」正文没明说就不能写)。
    ✦ update 时**称谓部分保持不变**(师姐吵架了还是师姐),通常只更新态度半句;称谓本身变了(结拜、成婚、相认)才连称谓一起改。
  ✦ ties:**与其他角色的重要关系**(高门槛)——只记长期结构性关系(血缘/婚姻/主仆/宿敌),一句话并列(如「阿黛尔之父;与镇长有旧怨」)。普通认识不记;对主角的内心好感与外在态度走 affinityInner/affinityOuter/affinityNote,不写 ties,不再新建对应的自定义变量。update 是整体覆盖,写累积后的完整内容;质变证据门槛与 relation 同。
  ✦ title:身份/职业一句话(如「归雁客栈掌柜」「主角的青梅竹马」)——**最重要**,这是该 NPC 不在场时仍会保留的核心身份信息。
  ✦ desc:**固定外貌**——只写发色、身材、五官、疤痕、惯常气质等**长期不变**的体貌特征,**不要写当下穿什么**(那是 outfit)。
  ✦ personality:性格(简短,如「沉默寡言、护短」)。
  ✦ 写不出 title 的角色基本没有记录价值,倾向不记。
${RULE_NPC_AFFINITY}
  ┃ 即时层(他现在怎么样,会变,覆盖型,鼓励跟剧情刷新):
  ✦ outfit:**当前着装**。与 desc 分离正是为了解决「角色一辈子不换衣服」——**门槛低**:正文一旦明确描写换装、更衣、衣物被弄脏/撕破/血染/打湿,就 update outfit 写出当前完整穿着。它是当前快照,不进历史,放心刷新。
  ✦ condition:**当前状态/健康**(受伤、疲惫、中毒、醉酒、虚弱等);无异常时不写。同为覆盖型,状态一变就 update,痊愈了就更新或清空。
【外貌(desc)与着装(outfit)铁律区分】「黑色长发、左眉有疤」→ desc(几乎不变);「今天穿红斗篷、佩长剑」→ outfit(随时可变)。绝不可把当下穿着写进 desc,否则又会被冻结。

【主要角色(important)—— 核心主演的状态追踪】
  ✦ 何为主要角色:在剧情里**反复出场、戏份吃重的核心主演**(常驻主角团、主线关键人物)。它们的身份/性格/外貌设定通常已在角色设定里,**无需你费笔墨记档案**。
  ✦ 标记:认定某角色已成为主要角色 → 在其 add/update 里带 important:true。也可能由用户手动标记。
  ✦ 主要角色永远全量发给后续剧情(不受在场与否影响),所以对它们**重点维护即时层**(outfit/condition/location),title 给一句帮定位即可,desc/personality 可省。
  ✦ 不要滥标:绝大多数 NPC 是配角,important 省略即可;只有真正的核心主演才标。
【随行 / 所在地(follow / location)—— 省 token 核心】只有「随行」或「在当前所在地」的 NPC 才会把完整信息发给后续剧情,其他地方的 NPC 只发名字+身份。
  ✦ 定点(默认):NPC 待在某地点 → location 填那个地点(复用上方【当前地点】或正文地名原文),follow 省略即可。
  ✦ 随行:NPC 作为同伴**跟随主角一起行动/赶路**(队友、随从、暂时同行者)→ follow:true(此时不必写 location,随主角移动;**也不要写 location:""**——空串只表示所在不明,不是“没有地点”)。
  ✦ 移动 NPC:某 NPC 加入队伍同行 → update follow:true;同伴离队留在某地 → update follow:false + location 填留下的地点;NPC 自己从一地去了另一地 → update location 改成新地点。
  ✦ 离场但去向未写明(正文只写告别/离开场景,没说要去哪)→ update follow:false + location 填空字符串 ""(表示所在不明,系统**不再**视为在场);绝不能保留旧地点冒充还在原处。**离队必须写 follow:false**:系统绝不会仅凭空 location 取消随行,只写 location:"" 仍按随行处理。之后正文说明去向时再 update location 填新地点;重新同行 → follow:true。
  ✦ location 命名务必复用既有地名原文,否则系统无法判断 NPC 是否在场。
  ✦ 首次记录某 NPC 时,通常正与其在当前地点互动 → location 填【当前地点】(除非正文明确该 NPC 是随行同伴)。
【何时更新(update)】
  ✦ **在场对账(每楼必过)**:名册每条带〔在场〕/〔同区域〕/〔不在场〕标记(系统按**本楼开始前**的状态算好)。逐条核对:标〔在场〕的角色本楼离开/告别/被留在原地而主角离开 → 必须更新 location 或 follow;标〔不在场〕的角色本楼归来/与主角同处 → 必须更新回在场(follow:true 或 location 填当前地点)。更新位置后,同步把 sceneFocus.participants 改成与实际在场名单一致(冲突以正文为准),不要两边各说各话。
  ✦ 档案层(title/desc/personality):只在**发生实质变化**或**首次补全**时更新;普通互动、对话不更新。update 的 desc/title 是整体覆盖,要写累积后的完整内容,别丢旧要点。
  ✦ 即时层(outfit/condition):门槛低,正文描写了换装/受伤/状态变化就 update,这是它存在的意义。
  ✦ 清空语义:outfit/condition 省略=保持旧值;填空字符串=明确清空(伤势痊愈、状态恢复正常、不再描述当前着装时务必清空,不要让旧状态永久残留)。
【主要角色的离场演变(唯一允许的合理推演,务必克制)】
  ✦ 通常铁律是「只记正文明写的」。**唯一例外**:对**主要角色**的**即时层**(outfit/location/condition),当其与主角分开**已明显跨越时间**(隔了数日、一场长旅程、一次大事件)后再登场或被提及时,允许你**合理推演**其状态的自然演变并 update —— 例如多日未见多半已换装、可能已移动到别处、伤势已痊愈或恶化。
  ✦ 目的:避免「两人分开两天重逢,对方还穿着分别时那套、伤还没好」这种僵化。
  ✦ 严格边界:此推演**仅限主要角色、仅限 outfit/location/condition 三个覆盖型字段**;**绝不可**外溢到 summary 正文、items、计划,也不可用于普通配角——那些仍严格只记正文明写,禁止脑补。推演要符合常理、点到为止,不要编造具体剧情事件。
【退场(remove)】NPC 永久退场(死亡、彻底离开剧情且不会再出现)才 remove;只是暂时分开、去了别处用 location/follow 表达,不要 remove。
【复用已有,严禁重复】上方【已登场NPC】是已记录名册。同一角色务必复用既有名字,不要换个叫法再记一遍;已在名册里且无变化 → 不输出 npcs。`;

/** 互动局势卡规则(sceneFocus 字段)。 */
export const RULE_SCENE_FOCUS = `═══ 【互动局势卡规则】(sceneFocus 字段,覆盖型单对象) ═══
它是「眼下正在发生什么」的一小张快照,帮写作 AI 衔接当下场面。整卡覆盖语义,默认不动:
  ✦ 省略 sceneFocus = 保持上一张;写 null = 明确清空(场面彻底结束/章节落幕才用)。
  ✦ 要写就写完整一张卡(不是补丁):situation + participants 必填,其余可选。
【更新时机】满足任一才更新,否则省略:
  ✓ 场面/在场人实质切换(换场地、有人进场离场、从闲聊转入正题)
  ✓ 当前活动实质转移(开始商量新的事、进入新活动)
  ✓ 互动张力出现或解除(开始冷战、气氛缓和)
  ✗ 同一局面里的普通推进(一句话一个动作)不更新——那是 summary 的事。
【字段口径】
  ✦ situation:当前局面一句话,客观描述,可在句中自然带出此刻围绕什么进行。陪伴/日常剧情写互动氛围(「午后同居日常,她情绪有点低落,正教 {{user}} 做菜」);剧情向写处境(「潜行中,刚被巡逻队发现」)。
  ✦ participants:当前在场参与者(含主角,用 {{user}})。必须与 NPC 名册的〔在场〕标记一致:更新 NPC 的 location/follow 后,同一条 delta 内同步修正 participants(以正文为准)。
  ✦ tension:互动张力,高门槛。只有明确的、正在持续的社交张力才写(冷战/尴尬/暧昧暗涌);一时的语气变化、普通情绪波动不写。无则省略。
  ✦ pendingBeat:即将发生之事,仅限正文明确预告/约定/已启动等待结果的(「她刚起身说去开门」)。禁止预测未发生剧情;无则省略。
【克制】本卡与 tension 是写给写作 AI 的隐性氛围约束(别在冷战时写成腻歪),不是点名要求;正文自然体现即可,严禁复述或点破本卡内容。`;

/** 生活小档案规则(lifeDetails 字段)。 */
export const RULE_LIFE_DETAILS = `═══ 【生活小档案规则】(lifeDetails 字段,极严筛选) ═══
记录**主角及主要角色**的偏好/习惯/近期个人状态,帮写作 AI 在相关时自然贴合;不扩展到路人或一次性配角。
【所属人物必填】每条 add 必须带 subject:主角固定写字面值 "user"(不是主角姓名),主要角色写 NPC 名册中的确切名字(含本楼按 NPC 规则新增/标记 important 的主要角色)。一条只属于一个人,多人相同习惯分开记录。text 写该人物的具体细节,展示时系统会补上姓名;把“我/他/她”解析成明确所属人物,不把说话者、被谈论者或 user 混为一人。主语不明宁可不记。
【铁律:只认本人明确陈述、或正文明确揭示的事实】禁止从行为/语气推断偏好与内心;一次吃了煎饼不等于爱吃煎饼。引语、转述、玩笑、反讽或猜测不能直接当成该人物的真实习惯;没有可靠明文依据不记。好感与态度估计不写这里。
【默认不记】先对照上方【生活小档案】按“同一人物 + 同义内容”查重,已有条目不重复 add;不同人物即使文字相同也不合并。旧条目缺 subject 仅按旧协议视为主角,不要自行改判成某个 NPC。
【add】topics 填 1-3 个主题标签(饮食/作息/工作…),anchors 填原文可检索的关键词(香菜/项目…),供系统按相关性投放;until 填故事内到期时间表示有时效(如项目结束日),长期稳定偏好 until 留空。
【update/archive/remove】用编号 d1、d2… 指代上方列表,先核对所属人物:
  ✦ 条目被正文明确推翻/纠正 → update 改 text;只有明确记错归属时才改 subject,省略 subject=保持原人物;
  ✦ 时效已过/不再相关 → archive(沉降为仅触发,不是删除);
  ✦ 记错了 → remove。拿不准不动,不能用另一个人的偏好覆盖本人的条目。
【分工】饮食、作息等生活细节归这里;身份/外貌/当前着装/健康状态仍归 protagonist 或 npcs,不要重复记录。这里只放值得跨场景保留的细节,不是每轮流水账。
【克制】这些细节仅作相关人物的写作参考,不是写作任务;严禁在 summary 里逐条罗列,不得把某人的习惯套给别人。`;

/** 计划/悬念规则(plans 字段)。 */
export const RULE_PLANS = `═══ 【计划/悬念规则】(plans 字段) ═══
分"计划"(plan)和"悬念"(suspense)两类。共同铁律:【默认不写】。只有确信一件事必须被长期记住、否则会损害后续剧情,才记。绝大多数楼层不产生任何 plans.add。
━━ 准入第一关:跨场景存活测试(最重要) ━━
问:"这件事会在接下来一两个回合的自然推进里得到结果吗?"
  会 → 不写。它只是当前还没写完的剧情,交给 summary 即可。
  只有需要【时间跨度】或【外部条件】才能解决的事,才可能进入。
反例(会很快兑现 → 一律不写):女主犹豫念不念情书、有人敲门、对方欲言又止、检定待揭晓、"他会怎么回答"、单纯沉默/离场、普通等待赶路、普通寒暄约饭。
正例(跨得过当前场景 → 才考虑):三日后决斗、毒药七天后发作、铁匠承诺改日打造武器、某组织正在暗中追查。
━━ 计划专属:意图真实性测试(过滤敷衍/客套/口嗨) ━━
过了第一关也别急着写。再问:"说话人是认真要去做、还是只是随口一句?"——只有【真心、当真的承诺/打算】才算计划,社交辞令和敷衍一律丢弃。
判断依据(只看文本明写的,不脑补):有无具体对象/时间/条件?是否被反复确认或郑重其事?后续言行是否当真?语气是认真还是打发、客套、嘴上应付?
反例(敷衍/客套/口嗨 → 不写):"下次再说吧""改天一定""有空一起吃饭""以后再聊""回头看看"等用来结束话题或客气的话;一时冲动的气话、酒后随口、明显的玩笑或反讽。
正例(真心当真 → 才考虑):明确约定了时间地点的会面、郑重立下的誓言/赌约、为兑现已开始做准备的承诺。
拿不准对方是不是认真 → 视为敷衍,不写。
  · "计划"= 正文明确给出行动主体【真心】决定、承诺、约定要做的未来行动。无论主体是 {{user}}、角色还是 NPC,只要重点是"这个人打算做什么",都归计划。
━━ 悬念专属:类型准入测试(必须命中一种,否则不写) ━━
悬念簿是【待揭晓事实 / 已启动外部事件】清单,不是剧情笔记、人物心境档案或设定摘抄。候选 suspense 只允许以下两类:
  A.【待揭晓事实】正文明确留下未知的身份、动机、来源、去向、真相或异常原因,并给出具体的异常、线索、隐瞒或相互冲突的证据。未知点必须由正文提出,不能由你自行制造"也许还有秘密"。
  B.【已启动外部事件】某个不以角色口头承诺为核心的外部进程已经实际开始,并朝具体结果推进,后续等待其客观结果。例如追捕已经展开、毒药进入倒计时、触发条件已经成立。仅仅具备能力、存在弱点或有可能发生危险,不算事件已经启动。
【绝非悬念】以下内容即使重要、长期存在、尚未解除,也不得写 suspense:
  · 已经解释清楚的世界观设定、能力机制、仪式规则、代价、副作用;
  · 伤势、诅咒、灵魂绑定、无法攻击某人等持续状态;
  · 人物的内心挣扎、感情纠葛、身份/职责矛盾、关系张力;
  · "存在弱点""可能被利用""构成潜在威胁""埋下隐患""矛盾将持续";
  · 只是尚未改变/解除、但没有未知答案也没有推进中外部事件的事实。
这些内容需要保留时写进 summary、人物状态或其它对应字段,不得包装成 suspense。
【禁止万能疑问】不得仅用"X会不会Y?""将如何收场?""未来会造成什么后果?"把已知状态改写成悬念——任何持续状态都能套这些句式,它们不能证明存在悬念。
【content 写法】只写一两句客观的【已知关键事实 + 精确未决点】或【已启动事件 + 待定结果】;禁止抒情、剧情评论和"潜在威胁/矛盾持续"式收尾。
━━ 新增前查重:按未知答案/待决事件归一 ━━
写任何 plans.add 前,逐条核对上方【未了结】与【近期已了结】条目:
  · 把已有条目与候选 suspense 各自归一为"等待揭晓的答案是什么"或"等待结果的同一个外部事件是什么"。
  · 若答案会同时揭晓,或本质是同一个事件的结果 → 同一条,严禁 add。新线索、规则细节、阶段进展、佐证、人物反应与两难只写 summary,不另建悬念。
  · 仅仅根源相同不必强行合并:若未知答案不同、可各自独立揭晓,或确是两个独立外部事件,才可分别记录。
  · 已了结条目禁止换个说法重新 add。拿不准是否重复 → 视为重复,不写。
【悬念核销预检】新增前先设想未来如何 resolve:必须能写成"未知答案揭晓为……"或"已启动事件的结果为……"。如果只能写"这种状态后来消失/改变/缓和了",它就不是悬念。
【核销/了结】plans.resolve 每项都要写清**怎么了结的**,格式:{ "id":"p2", "outcome":"done|cancelled|failed", "reason":"一句话:关键事实+结果" }(id 用上方【未了结的计划/悬念】里的编号如 "p2")。
先问一句:"文本是否明确说明此事已解决/揭露/兑现/推翻/撤销/彻底不可能再发生?"——是且有依据→resolve;否或不确定→保留。悬念不因时间流逝自动消失。
outcome 三选一,务必分清:
  · done=计划真去做成/兑现了、悬念真揭晓了(结果/答案已明确);
  · cancelled=**没做成,而是被取消、撤回、放弃、作废、不再需要**(对方收回要求、情势变了、当场被化解退让等);
  · failed=尝试过但失败,或悬念以坏结局收场。
reason 必填一句,写清「为什么了结 / 如何收场」。⚠️最易错的坑:一件事「**被提出后又当场被化解、对方退让、承认搞错、不了了之**」→ 这是 **cancelled(取消/作废),绝不是 done**;reason 要写出「所以不用做了/此事作废」,否则后续会误判它仍然有效、仍需执行。
【计划时间】每条 plans.add 都要带 createdTime(该计划/悬念在剧情里被立下/出现时的故事内时间,取本段当前时间即可,用具体数字化日期时间);计划(plan)还应带 targetTime(打算去做/兑现的目标时间):
  · 有明确期限→写具体时间(如"放学后""1988/10/1");
  · 是泛泛的愿望、无明确期限(如"以后有机会一定要去看看")→targetTime 可写模糊描述或直接省略该字段。
  · 悬念(suspense)通常没有目标时间,可省略 targetTime。`;

/**
 * 自定义变量规则(vars 字段,路径命令)。仅当用户配置了变量(有当前状态或说明)时才注入(见 {{vars_rule}})。
 * 变量是一棵 JSON 状态树,AI 用 set/assign/remove/add 按路径自由增删改,可在【说明】约定下新建对象/字段。
 */
export const RULE_VARS = `═══ 【自定义变量规则】(vars 字段,路径命令) ═══
上方【自定义变量·当前状态】是一棵 JSON 状态树(结算到此刻);【变量含义】告诉你每个字段是什么;【变量变化规则】告诉你何时怎么变、可否新建。
当本回合正文里发生了明确、具体的事件、导致状态该变时,在 vars 字段输出一个**命令数组**去修改它。每条命令是一个对象:
  · 赋值/覆盖:{ "op":"set", "path":"路径", "value":新值 }
  · 数字增减:{ "op":"add", "path":"路径", "delta":增量 }(delta 可负,如 -10)
  · 往对象/数组里加(含**新建对象**):{ "op":"assign", "path":"父路径", "key":"新键", "value":值 };往数组末尾追加则省略 key
  · 删除:{ "op":"remove", "path":"路径", "key":"要删的键/下标/值" };删整个节点则省略 key、path 指向它
【路径】用点和方括号寻址:"势力.魔法议会.声望"、"队伍[0].hp"。父路径上缺失的中间层会自动创建。
【自由创建(重点)】允许你按剧情**新建**状态树里还没有的字段/对象——例如遇到一个新势力,用 assign 在「势力」下加一个对象(键=势力名,值=含各属性的对象),遵循【变量变化规则】里的约定。
【只改真正变的 · 防重复结算】当前状态已是结算到此刻的值。只对正文里**新发生**的事件发命令;没变的别发;上一段已经算过的账(如已 +5)本段无新事件就别再动。
【克制】不确定、纯推测、正文没提 → 不发命令。宁可少发,命令要准。无任何变化时,vars 直接省略或给空数组。`;

/**
 * 摘要正文的时间语言铁律。所有摘要层级共用,自定义模板也会在构造时强制追加。
 * 相对时间在生成当下可能正确,但存进长期记忆后会随「现在」移动而失真,故入库前就绝对化。
 */
export const RULE_ABSOLUTE_TIME_LANGUAGE = `═══ 【摘要时间语言铁律】(summary 字段,强制) ═══
- summary 正文严禁出现依赖叙述时点的浮动时间词,包括但不限于:"今天"、"昨天"、"前天"、"明天"、"后天"、"当天"、"当晚"、"次日"、"第二天"、"今晚"、"昨晚"、"明早"、"几天前"、"几天后"、"上周"、"下周"、"这个月"、"下个月"。
- 原文即使使用这些词,也必须依据本段起止时间、前情时间括注或当前故事时间,换算成固定的故事内绝对日期/时刻后再写入 summary。例如:"她说明天再来"应写成"她约定于 2025/7/19 再来";"昨晚发生袭击"应写成"袭击发生于 2025/7/17 夜间"。
- 关键台词里的浮动时间也不得原样照抄;应转述其固定后的实际含义。计划、承诺、截止时间等信息必须保留,不能为了避开浮动词而删掉。
- 若现有时间锚点确实不足以换算,只保留明确事实与先后关系并注明"具体日期未确定",严禁猜造日期。
- 绝对日期一旦写定,后续压缩必须原样保留;不得重新改写成任何相对时间。`;

/** 检查记录与最终数据分离;各级摘要及自定义模板共用同一输出约定。 */
export const SUMMARY_OUTPUT_PROTOCOL = SUMMARY_SPLIT.protocol;

/** 共用少量事实取舍原则,不要求额外的逐段审计表。 */
export const SUMMARY_FACT_PREPARATION = `【摘要取舍】
- 只整理本次待处理材料;历史、设定与快照用于核对,不当作本轮新增事件。单楼只摘本楼,批量不借后面楼补结论,压缩不补写未提供的原文。
- 优先保留关键事件与结果、状态变化、明确情报、比较基准,以及影响当前未结束局面或后续理解的条件。临时但仍有效的限制也可进入 summary,不套用长期档案的准入门槛;先压缩重复动作与修饰,不因删日常过程而丢掉其中的重要事实。
- 保留主体、说话人、关键数值与范围、确定程度;条件连同受影响对象及具体影响保留,不只留下主题词。区分建议、已决定、已启动与已完成,不将人物说法自动当作客观事实。
- 明确变化保留必要的前后阶段,不让旧状态冒充现状或把新状态倒写进过去;局部观察不扩大为普遍规则。冲突未获解释时保留分歧,不自行编造原因、精确时间或结论。`;

/** 直接回看材料及结果,不重复生成候选和覆盖记录。 */
export const SUMMARY_FACT_VERIFICATION = `【摘要复核】
- 对照原材料确认关键事实、限定与了结结果在 summary 中实际保留,合并不能吞掉独立事实;删除无依据的推断和续写。必要的历史变化不能仅因已写入状态字段就从 summary 省略。
- 只简记关键取舍与实际修正,不重复抄写摘要;最后按本任务的时间、篇幅和格式输出。`;

/** 内置单楼、批量及两级压缩共用成文顺序,不覆盖自定义模板。 */
export const RULE_SUMMARY_COMPOSITION = `【摘要成文顺序】
- 按剧情先后把状态、比较基准和限制放在对应阶段,与事件自然衔接,不强制前置或套固定句式;中途变化不得提前套用于更早阶段,无相关事实就直接写事件。
- 在本任务篇幅内先压缩重复过程和修饰(【关系线保留】所指的互动细节除外),保留主体、关键手段、结果、了结与必要因果,不让动作细节挤掉关键事实及其限定。保持单段自然叙述,不加标题、列表或新字段。`;

/**
 * 关系线保留:L0 摘要与两级压缩共用。
 *
 * 慢热关系由一串高度相似的可见小互动构成,而压缩规则天然视“同类重复”为噪声——
 * 若不单独声明,这条线会在 L1/L2 被合并删除,主模型与状态字段都拿不到“最近在往哪走”的趋势。
 * 本规则只要求保留可观察事实,不放开任何心理/关系结论的推断门槛(证据边界仍在各任务规则里)。
 */
export const RULE_RELATION_MOMENTUM = `═══ 【关系线保留】(摘要与压缩共用,不可当作重复日常删除) ═══
人物关系的发展常不靠大事件,而靠一串可观察的小互动:靠近与身体接触、主动照顾或维护、承诺与约定、称呼与语气的持续变化、送礼、玩笑、回避、沉默、争执与和好。
  ✓ 这类**具体动作与关键台词**,即使不推动主线、不改变任何档案字段,也必须作为独立语义单元保留一句,不得以“没有新事件”为由压缩掉。
    例:保留「她把椅子挪近,手搭在他手边」「他承诺不会让她吃亏,她没接话」,而不是删成「两人聊了几句」。
  ✓ 压缩跨时段时,同类互动若构成可观察的趋势,用「自X起……」概括保留并带代表性细节,不得作为“重复的亲密互动/调情”整段删除。
  ✗ 不得只留“日常相处”“关系有所变化”等空泛概括;也不得把互动改写成“感情升温”“关系恶化”等心理或关系结论——只记可见事实,证据边界不变。`;

/** 摘要撰写规则(summary 字段)。含 {{summary_words}} 宏,由 fill() 填字数。 */
export const RULE_SUMMARY_WRITE = `═══ 【摘要撰写规则】(summary 字段,必填) ═══
★ 核心目标:为未来的 AI 提供可靠的"前情提要",具体且信息密集,字数 {{summary_words}} 字。
★ 视角:【冷酷的监控摄像头视角】+【警察做笔录风格】。只描写视觉可见的动作、听觉可闻的对话、明确写出的事实,禁止任何文学修饰。
★ 必须包含(5W1H):① 核心互动(谁对谁做了/说了什么关键的话,写出具体动作或核心台词大意);② 状态/情绪(仅限文本明确写出的,客观动作就只写动作,禁止推导"隐秘心态");③ 新情报/结果(推进了什么、获得什么线索、达成什么共识、发生什么变故);④ 伏笔/悬念(若有)。
★ 持续事实与背景参照:本轮正文明确揭示、会影响后续理解的客观处境、规则条件及比较关系,即使不推动剧情也应保留;可压缩日常过程,不能连同其中的持续事实一起删除。
★ 状态与范围保真:明确变化须保留必要的阶段差异和变化后结果;关键数值连同所属对象、比较关系、适用范围及确定程度保留,不将局部事实泛化,不让旧状态覆盖后来阶段。
★ 条件与影响成对保留:对当前局面或后续理解有约束作用的事实,写清条件限制了谁或什么、具体影响及必要程度,不能只留下条件名称;意图、建议、已启动与已完成不得混写。
★ 时间锚定:按时间先后叙述,保留具体日期/时间、人名、地名、物品名、关键数值;禁止用"不久后/后来/第二天"等模糊词抹除真实时间。
★ 严禁无中生有:禁止写出原文未明确指出的情绪(禁止"这引出了…的珍视""体现了…的心态"等阅读理解句式);禁止氛围总结("气氛变得…")。
★ 严禁剧情续写:叙述必须严格止步于该楼正文的最后一个明文动作/对话,禁止补充正文未写出的后续动作/回应/离场,即便逻辑上"显然会发生"。截断靠"不写"、不靠"声明":以最后一个具体动作/对话自然收尾,不得用"原文/材料/本楼/本段/段号/摘要"等指代材料的词,也不得以"止于…""到此为止""尚未…""谁还没回应"之类交代材料边界或未发生内容的句子收尾。
★ 了结必写:本楼若有事件使先前提出的要求/意图/义务/威胁/悬念**被作废、取消、化解或了结**,summary 必须显式写出这个**结果**("……故此事作废/无需再去/已化解"),不能只叙述冲突过程而漏掉「所以不用做了」这一结论——漏掉它,后续压缩与续写都会误以为此事仍悬而未决。
★ 纯叙述句,不要标题、列表、加粗等任何 markdown 标记。

${RULE_RELATION_MOMENTUM}

${RULE_SUMMARY_COMPOSITION}

${RULE_ABSOLUTE_TIME_LANGUAGE}`;

const SUMMARY_INPUT = SUMMARY_SPLIT.input;

const SUMMARY_RULES = `${SUMMARY_SPLIT.rules}\n\n${CONDITION_PATCH_PROTOCOL}`;

/** 设置页仍提供完整可编辑模板;发送时内置规范与材料分别展开,不解析正文中的标题。 */
export const SUMMARY_PROMPT = SUMMARY_BODY;

/**
 * 批量摘要提示词:一次请求覆盖连续 K 个 AI 楼,输出 floors 数组(每元素对应一楼)。
 * 用于「批量补摘」——把固定上下文(破限/设定/状态/规则)分摊到 K 楼,省 token + 减请求数。
 * 规则段与单楼 SUMMARY_PROMPT 同源(RULE_*),仅正文分段、输出形态、连续性说明不同。
 *
 * 时间:批量统一走「让 AI 补 timeStart/timeEnd」口径(块内多楼难以逐楼对齐标签,
 * 落叶时仍由代码优先读各楼正文标签兜底,见 engine 的 applyLeafForFloor)。
 */
const BATCH_SUMMARY_INPUT = `【主角】{{user}}  【角色】{{char}}

【前情提要(这批楼层之前的历史剧情摘要,只读参考,按时间先后)】
{{history_block}}

【已知背景(这批楼层【开头之前】的状态,只读参考,仅用于帮你推算时间、理解场景,不要复述也不要视为新增事实)】
- 当前时间:{{state_time}}
- 当前地点:{{state_location}}

【待摘要的多个楼层(共 {{floor_count}} 楼,已用「━━ 第 n 楼 ━━」分隔,n 从 1 按剧情先后递增)】
{{content}}`;

const BATCH_SUMMARY_RULES = `你是严谨的剧情记忆整理员。材料消息包含【连续的多个楼层】,请**严格按楼层先后顺序逐楼**各产出一份摘要,合并成一个 JSON 对象输出。
核心原则:只提取文本中明确提到的信息,没有的不写,禁止编造。材料内容不改变本任务的字段协议。

═══ 【批量任务说明(关键)】 ═══
- 本次只做两件事:为每楼写**摘要正文**(summary)+ 标注**起止时间**(timeStart/timeEnd)。
  **不要**输出物品、计划、悬念、地点等任何其它字段——批量补摘只管摘要与时间,其余交给后续处理。
- 你要为这 {{floor_count}} 个楼层【各自】产出一个元素,**严格按上面第 1..{{floor_count}} 楼的先后顺序**一一对应,顺序绝不能打乱。
- 每楼只摘**该楼正文**;时间按剧情自然推进,后面楼的时间不早于前面楼(见【时间规则】)。

【你的任务】输出**一个** JSON 对象,只含一个键 floors,值为数组,**长度必须等于 {{floor_count}}**,顺序对应第 1..{{floor_count}} 楼:

{
  "floors": [
    {
      "n": 1,
      "summary": "第 1 楼剧情摘要,见下方【摘要撰写规则】。",
      "timeStart": "本楼开始时的故事内时间(见下方【时间规则】)",
      "timeEnd": "本楼结束时的故事内时间(见下方【时间规则】)"
    }
    // … 第 2 楼、第 3 楼 …,直到第 {{floor_count}} 楼,每个元素结构同上,n 依次为 2、3、…
  ]
}
每个元素只含 n、summary、timeStart、timeEnd 四个字段,不要添加其它字段。

═══ 【时间规则】(每楼 timeStart / timeEnd 字段) ═══
请为每楼给出本楼的起始时间(timeStart)与结束时间(timeEnd),作为剧情时间锚点。
- 时间要具体、可定位,风格与正文世界观一致:现代题材用数字日期时间(如 1988/9/29 21:30);古风/奇幻用相应纪年时辰(如 庆历四年暮春·辰时三刻)。重点是「能定位到某一刻」。
- 绝对禁止"未知""某年某日""某日""稍晚""不久后""同一天"等无法定位到具体时刻的模糊说法。
- 填法:① 该楼正文明写了时间→直接采用;② 没明写→以上方"当前时间"及前面各楼推进为基准,结合本楼剧情流逝(对话约几分钟、用餐约一小时、过夜跨到次日等)推算出具体时间;③ 全无依据→自行设定一个符合世界观的合理起点。
- **允许且要求合理推测**:据上下文推算出一个具体时间,属于基于剧情的合理设定,**不算编造**;宁可给一个不完美但具体的时间,也绝不能留空或写模糊词。这是建立时间锚点所必需。
- **时间必须单调递增**:第 n 楼的时间不得早于第 n-1 楼;若某楼时间没推进,timeStart 与 timeEnd 写同值即可。

${RULE_COMPLETE_TIME_ANCHOR}

${RULE_SUMMARY_WRITE}

【输出铁律】
- 检查记录之后的最终 JSON 根键只有 floors;floors 长度严格等于 {{floor_count}},n 从 1 连续到 {{floor_count}},不可缺楼、不可多楼、不可乱序。
- 每个元素只含 n / summary / timeStart / timeEnd,不要输出 items / plans / location 等字段。`;

export const BATCH_SUMMARY_PROMPT = `${BATCH_SUMMARY_RULES}\n\n${BATCH_SUMMARY_INPUT}\n\n${SUMMARY_OUTPUT_PROTOCOL}`;

/**
 * 批量摘要的思考清单(压在 user 之后)。保留逐楼对齐与时间检查,
 * 共用事实整理流程,不引入单楼的物品/NPC 等状态更新盘点。
 */
export const BATCH_THINKING_CHECKLIST = `【输出前思考(逐楼核查)】
${SUMMARY_OUTPUT_PROTOCOL}
在同一个检查块内按楼层顺序完成以下检查,全部完成后闭合检查块再输出 JSON:
1. 逐楼定位:这批共 {{floor_count}} 楼,我将**严格按先后顺序**为每楼产出一个数组元素,n 依次 1..{{floor_count}},不漏、不重、不乱序。
2. 时间单调且完整:每楼标起止时间,后一楼不早于前一楼;无依据则按剧情流逝合理推算。现代/数字日期的两端都必须包含完整年份,不得缩写成月日或单独时刻。
3. 收笔:每楼 summary 止步于该楼正文最后一个明文动作,不续写、不跨入下一楼。
4. 只产摘要+时间:每个元素只含 n / summary / timeStart / timeEnd,不输出物品、计划、地点等字段。

每楼以「第 n 楼」简记关键取舍或修正,依次核对以下要点,不重复抄写正文。前面楼只作历史参考,不得借后面楼补齐当前楼的结论。正文的 [M消息序号-P段序号] 只供定位,不等于结果的 n。
${SUMMARY_FACT_PREPARATION}

${SUMMARY_FACT_VERIFICATION}

核查完所有楼后闭合 </thinking>,再输出 JSON 对象(根键 floors),无 markdown 围栏、无额外解释。`;

/**
 * 时间规则有两种形态,由「被分析正文是否带 <bbs_start>/<bbs_end> 时间标签」决定:
 *  - 有标签:时间由插件从标签直读(权威锚点),AI 不必再算 → 省 time 字段。
 *  - 无标签(多为开篇/老对话):让 AI 补出 timeStart/timeEnd 两端,作为锚点兜底。
 * buildSummaryPrompt 据此填充 {{time_field}}(JSON 模板里的字段说明)与 {{time_rule}}(规则段)。
 */
export const TIME_FIELD_WITH_TAGS = `  // 时间已由正文标签提供,无需输出 time 字段`;
export const TIME_RULE_WITH_TAGS = `═══ 【时间规则】 ═══
本轮正文已带时间标签,故事内时间由系统自动读取,你**无需输出 time / timeStart / timeEnd 字段**。检查期限时直接采用本楼结束时间,不得重新推算已有的时间锚点。`;

export const TIME_FIELD_NO_TAGS = `  "timeStart": "本段开始时的故事内时间,见下方【时间规则】。",
  "timeEnd": "本段结束时的故事内时间,见下方【时间规则】。",`;
export const TIME_RULE_NO_TAGS = `═══ 【时间规则】(timeStart / timeEnd 字段) ═══
本轮正文没有时间标签,请你给出本段的起始时间(timeStart)与结束时间(timeEnd)两个值,作为剧情的时间锚点。
- 时间要具体、可明确定位,风格与正文世界观一致:现代题材用数字日期时间(如 1988/9/29 21:30);古风/奇幻题材用相应纪年与时辰(如 庆历四年暮春·辰时三刻)。重点是「能定位到某一刻」,不强求阿拉伯数字。
- 绝对禁止"未知""某日""稍晚""不久后""同一天"等无法定位到具体时刻的模糊说法。
- 填法优先级:① 正文明写了时间→直接采用;② 正文没明写→以上方"当前时间"为基准,结合本回合剧情流逝(对话约几分钟、用餐约一小时、过夜跨到次日等)推算;③ 连参考状态都没时间→自行设定一个符合世界观的合理起点。
- 这是为剧情建立时间锚点所必需,属于基于上下文的合理设定,不算编造;宁可给一个不完美但具体的时间,也绝不能留空或写模糊词。
- 若本段时间没有推进(起止相同),timeStart 与 timeEnd 写同一个值即可。

${RULE_COMPLETE_TIME_ANCHOR}`;

const RESUMMARY_INPUT = RESUMMARY_SPLIT.input;

const RESUMMARY_RULES = RESUMMARY_SPLIT.rules;

export const RESUMMARY_PROMPT = RESUMMARY_BODY;

/**
 * 二次总结(L1+ → 更上层):把已经压过一轮的多条总结再压一层。
 * 与普通总结的关键差异——篇幅按输入规模动态给预算:详细档参考 40%–50%,
 * 精简档参考 30%–40%;内置模板把下限视为参考、上限视为硬预算,避免为凑字数保留流水细节。
 * 字段输出仍是 { summary }(与普通总结同口径,便于 extractJsonObject 复用)。
 */
const RESUMMARY2_INPUT = RESUMMARY2_SPLIT.input;

const RESUMMARY2_RULES = RESUMMARY2_SPLIT.rules;

export const RESUMMARY2_PROMPT = RESUMMARY2_BODY;

/** 两级压缩沿用摘要的显式检查记录,但不执行物品/NPC 等状态更新。 */
export const RESUMMARY_THINKING_CHECKLIST = protocolSection('RESUMMARY_THINKING_CHECKLIST');

/**
 * 破限提示词默认值:作为置顶 system 附加在摘要/总结请求里,降低副 API 对露骨/暴力内容的拒答率。
 * 用户可在设置里覆盖;留空(清掉)则不附加。摘要任务面对的是已生成的正文,需如实记录而非二次审查。
 * 破限 = 纯 NVWA 独立核心(不含 04 后面那段「记忆整理任务说明」)。作为独立 system 消息置于每个记忆请求最前。
 */
export const JAILBREAK_PROMPT = (() => {
  const close = '</nvwa_standalone_core>';
  const end = tasksRaw.indexOf(close);
  return end >= 0 ? tasksRaw.slice(0, end + close.length).trim() : tasksRaw.trim();
})();

interface BuildArgs {
  user: string;
  char: string;
  time: string;
  location: string;
  /** 用户操控主角的当前客观档案 */
  protagonist: MemProtagonist;
  /** 当前互动局势(上一张局势卡,覆盖到该楼之前;只读参考,null=无) */
  sceneFocus: SceneFocus | null;
  /** 主角及主要角色的生活小档案(当前已记录;供人物核对、查重与 d 序号指代) */
  lifeDetails: MemLifeDetail[];
  /** 现有物品名列表 */
  items: { name: string; qty?: number; desc?: string; carried?: boolean; location?: string }[];
  /** 近期物品变动日志(已结算的账,防重复结算用) */
  itemLog: ItemLogEntry[];
  /** 已知地点(完整路径 + 描述,供 AI 复用命名、防重复记录、判断 reparent) */
  scenes: { path: string[]; desc?: string }[];
  /** 已登场 NPC(供 AI 复用命名、防重复记录、判断状态更新) */
  npcs: NpcSummaryView[];
  /** 未了结计划(顺序即编号 p1..pn);createdTime/targetTime 为故事内时间(可空) */
  openPlans: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
  /** 近期已完成的计划/悬念(已按 resolvedAt 倒序取好最近 N 条);防副模型重复记录。空数组→渲染「(无)」 */
  resolvedPlans: MemPlan[];
  /** 本轮之前的历史摘要文本(已选「最高压缩层」节点拼接);空表示无前情 */
  history: string;
  /** 待摘要的正文 */
  content: string;
  /** 正文是否已带 <bbs_start>/<bbs_end> 时间标签:有则时间走标签、提示词省去 time;无则让 AI 补两端 */
  hasTimeTags: boolean;
  /** 自定义变量当前状态(结算到本楼之前的 JSON 树;空对象+空说明=未启用,提示词里整块省略) */
  varsState: Record<string, JsonValue>;
  /** 变量含义(合并三层 meaning):各字段是什么;主/副API都拿到 */
  varsMeaning: string;
  /** 变量变化规则(合并三层 rule):何时怎么改/可否新建;仅副API拿到 */
  varsRule: string;
}

/**
 * 单行化:把值里的换行折叠成空格。名册/物品/地点/计划都是「一条一行、字段内联拼接」的格式,
 * 值内含换行会把一条拆成多行、破坏结构、误导模型。故所有内联字段渲染前都过此函数(trim 拦不住中间换行)。
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function fmtItems(items: BuildArgs['items']): string {
  if (!items.length) return '  (无)';
  return items
    .map(i => {
      const qty = typeof i.qty === 'number' ? ` ×${i.qty}` : '';
      const desc = oneLine(i.desc) ? ` —— ${oneLine(i.desc)}` : '';
      // 随身/存放地标注:随身(默认)不标,非随身标 [存:地点],让 AI 知道现状以便正确移动物品
      const place = i.carried === false ? ` [存:${oneLine(i.location) || '某处'}]` : '';
      return `  - ${i.name}${qty}${place}${desc}`;
    })
    .join('\n');
}

/** 主角当前客观档案。字段始终全量展示,不参与 NPC 的在场分档。年龄显示带锚点(勿再重复记录)。 */
export function fmtProtagonist(protagonist: MemProtagonist): string {
  const age = protagonist.age
    ? `${protagonist.age}${protagonist.ageTime ? `(记录于 ${protagonist.ageTime})` : ''}`
    : '';
  const rows: Array<[string, string | undefined]> = [
    ['性别', protagonist.gender],
    ['年龄', age],
    ['身份', protagonist.identity],
    ['外貌', protagonist.appearance],
    ['着装', protagonist.outfit],
    // 状态渲染成 [c1]/[c2] 编号片段,供 conditionPatch 按编号局部更新
    ['状态', fmtConditionFragments(protagonist.condition)],
  ];
  const lines = rows
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  return lines.length ? lines.join('\n') : '  (暂无记录)';
}

/**
 * 已知地点树(带层级缩进 + 描述):供 AI 复用命名、避免重复记录、判断 reparent 挂接关系。
 * 按路径字典序排,深度即缩进;每级显示本级名 + 描述。空则「(无)」。
 */
export function fmtScenes(scenes: BuildArgs['scenes']): string {
  if (!scenes.length) return '  (无)';
  // 按完整路径字典序排,保证父级先于子级、同级相邻
  const sorted = [...scenes].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  return sorted
    .map(s => {
      const depth = Math.max(0, s.path.length - 1);
      const indent = '  '.repeat(depth + 1); // 至少一级缩进对齐其它块
      const name = s.path[s.path.length - 1] ?? '';
      const desc = oneLine(s.desc) ? ` —— ${oneLine(s.desc)}` : '';
      return `${indent}- ${name}${desc}`;
    })
    .join('\n');
}

/**
 * 已登场 NPC 名册:供 AI 复用命名、避免重复记录、判断更新/退场/状态演变。
 * 每条显示 名 + 性别 + 年龄(带记录时点,示意「已记过、勿重复」)+ ★主要 + [随行/所在地] + 身份
 * + 与主角关系 + 与其他角色的长期关系 + 当前即时状态(着装/状态)。
 * 性别在所有分档都发(包括不在场),防 AI 搞错性别;即时状态进名册是有意为之:
 * AI 要据此判断「是否该更新着装」「离场的主要角色该不该推演演变」。
 * 性格/外貌仍不进(够识别复用即可,省 token)。空则「(无)」。
 */
export function fmtNpcs(npcs: BuildArgs['npcs']): string {
  return fmtNpcSummaryList(npcs);
}

/**
 * 把近期物品变动日志格式化成给模型看的列表。
 * 数量变化用 from→to 表达(都已知时);只标方向词(获得/变更/消耗尽)在没有数量时兜底。
 * 空则返回 "(无)"。
 */
export function fmtItemLog(log: ItemLogEntry[]): string {
  if (!log.length) return '  (无)';
  const kindWord = (k: ItemLogEntry['kind']): string =>
    k === 'add' ? '获得' : k === 'remove' ? '移除' : '变更';
  return log
    .map(e => {
      const time = e.time?.trim() ? `${e.time.trim()}:` : '';
      // 数量变化:两端都已知且不同 → from→to;否则只给方向词
      const hasFrom = typeof e.from === 'number';
      const hasTo = typeof e.to === 'number';
      let qty = '';
      if (hasFrom && hasTo && e.from !== e.to) qty = `(${e.from}→${e.to})`;
      else if (!hasFrom && hasTo) qty = `(×${e.to})`;
      else if (hasFrom && !hasTo) qty = `(原×${e.from})`;
      return `  - ${time}${e.name} ${kindWord(e.kind)}${qty}`;
    })
    .join('\n');
}

/**
 * 写进正文 <bbs_items> 旁注用的「动词式」多行格式(一行一物品,每行必带数量)。
 * 动词由数量增减方向决定(不看 kind):to>from→获得、to<from→消耗、清空(to=0)→失去。
 * 数量 = 本次涉及的差额(|to-from|)。一切物品都计数,from 缺省按 0 起算(新物品)。
 * 例:
 *   获得 匕首 1
 *   消耗 解药 1
 *   失去 火把 2
 * 空则返回空串(调用方据此不写块)。
 */
export function fmtItemLogInline(log: ItemLogEntry[]): string {
  if (!log.length) return '';
  const lines: string[] = [];
  for (const e of log) {
    const from = typeof e.from === 'number' ? e.from : 0;
    const to = typeof e.to === 'number' ? e.to : 0;
    const diff = to - from;
    if (diff === 0) continue; // 无数量变化(纯描述更新)不写进旁注
    if (to <= 0) lines.push(`失去 ${e.name} ${from}`); // 清空:失去原有全部
    else if (diff > 0) lines.push(`获得 ${e.name} ${diff}`);
    else lines.push(`消耗 ${e.name} ${-diff}`);
  }
  return lines.join('\n');
}

/* ============ 自定义变量:JSON 状态渲染(注入 / 提示词) ============ */

/** 把当前变量状态 JSON 渲染成可读文本(缩进 JSON)。空对象→「(空)」。 */
export function renderVarsState(json: Record<string, JsonValue>): string {
  if (!json || !Object.keys(json).length) return '(空)';
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return '(无法显示)';
  }
}

/**
 * 选「近期已完成的计划/悬念」:**计划与悬念各取最近 n 条**(分别按 resolvedAt 倒序),再合并。
 * 分类计数的原因:计划(角色主动要做)被了结后最易被 AI 当未完成又去推进 —— 重复风险高;
 * 而悬念(被动未决项)很少被主动重新 add。若混合取 N,一批集中了结的悬念会把计划挤出列表,
 * 恰恰丢掉最该留住的那类。分别取 N 保证两类都有代表、计划一定在。
 * 注入端与副API共用同一选择逻辑 —— 口径一致,只差传入 plans 的截止点
 * (注入用全量 memory.plans;副API用 deriveMemory(chat, beforeIndex).plans)。
 * n<=0 或无已了结项 → 空数组(调用方据此不渲染整块)。最终列表按 resolvedAt 倒序便于阅读。
 */
export function selectRecentResolvedPlans(plans: MemPlan[], n: number): MemPlan[] {
  if (!(n > 0)) return [];
  const resolved = plans.filter(p => p.status === 'resolved');
  const byTimeDesc = (a: MemPlan, b: MemPlan): number => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0);
  const plansTop = resolved.filter(p => p.kind === 'plan').sort(byTimeDesc).slice(0, n);
  const suspenseTop = resolved.filter(p => p.kind === 'suspense').sort(byTimeDesc).slice(0, n);
  return [...plansTop, ...suspenseTop].sort(byTimeDesc);
}

/**
 * 了结方式的中性显示标签(按 kind 措辞,读着自然)。无 outcome(旧数据)→「已了结」。
 * 关键:cancelled 明确显示「已取消/已作废」,不再和 done 混成「已完成」,主模型才不会误判还要做。
 */
export function outcomeLabel(kind: MemPlan['kind'], outcome?: PlanOutcome): string {
  if (kind === 'suspense') {
    return outcome === 'done' ? '已揭晓' : outcome === 'cancelled' ? '已作废' : outcome === 'failed' ? '已落空' : '已了结';
  }
  return outcome === 'done' ? '已达成' : outcome === 'cancelled' ? '已取消' : outcome === 'failed' ? '已失败' : '已了结';
}

/**
 * 渲染「近期已了结的计划/悬念」列表(不编号——它们已了结,无需像未了结项那样供 resolve 指代)。
 * 每条:[计划·已取消] 内容 —— 了结原因 (立于 X · 目标 Y)。了结方式与原因是关键:告诉主模型
 * 「这事怎么下架的、为什么」,消除「已完成却还反复提」的困惑。空则「(无)」。
 */
export function fmtResolvedPlans(plans: MemPlan[]): string {
  if (!plans.length) return '  (无)';
  return plans
    .map(p => {
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`立于 ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`目标 ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      const tag = `${p.kind === 'suspense' ? '悬念' : '计划'}·${outcomeLabel(p.kind, p.outcome)}`;
      const reason = oneLine(p.resolvedReason) ? ` —— ${oneLine(p.resolvedReason)}` : '';
      return `  - [${tag}] ${oneLine(p.content)}${reason}${time}`;
    })
    .join('\n');
}

export function fmtPlans(plans: BuildArgs['openPlans']): string {
  if (!plans.length) return '  (无)';
  return plans
    .map((p, idx) => {
      // 时间括注:有创建/目标时间才带上,格式 A —— (立于 X · 目标 Y),任一缺失则只显示存在的那个
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`立于 ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`目标 ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      return `  p${idx + 1}. [${p.kind === 'suspense' ? '悬念' : '计划'}] ${oneLine(p.content)}${time}`;
    })
    .join('\n');
}

/** 局势卡渲染给副 API(只读参考,单行内联)。null → (无)。 */
export function fmtSceneFocus(f: SceneFocus | null): string {
  if (!f) return '  (无)';
  const bits: string[] = [`局面:${oneLine(f.situation)}`];
  const who = f.participants.map(oneLine).filter(Boolean).join('、');
  if (who) bits.push(`在场:${who}`);
  if (f.currentFocus) bits.push(`焦点:${oneLine(f.currentFocus)}`);
  if (f.tension) bits.push(`张力:${oneLine(f.tension)}`);
  if (f.pendingBeat) bits.push(`将发生:${oneLine(f.pendingBeat)}`);
  return `  ${bits.join(' | ')}`;
}

/** 生活小档案渲染给副 API(编号 d1/d2… 供 update/archive/remove 指代)。 */
export function fmtLifeDetails(details: MemLifeDetail[], userName = '主角'): string {
  if (!details.length) return '  (无)';
  return details
    .map((d, idx) => {
      const tierLabel = d.tier === 'pinned' ? '置顶' : d.tier === 'archive' ? '沉降' : d.until ? `时效·至${oneLine(d.until)}` : '长期';
      const meta: string[] = [];
      if (d.topics.length) meta.push(`主题:${d.topics.map(oneLine).filter(Boolean).join('/')}`);
      if (d.anchors.length) meta.push(`词:${d.anchors.map(oneLine).filter(Boolean).join('/')}`);
      return `  d${idx + 1}. [${tierLabel}] ${oneLine(fmtLifeDetail(d, userName))}${meta.length ? ` (${meta.join(' | ')})` : ''}`;
    })
    .join('\n');
}

function fill(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? '');
}

/**
 * 字数档位配置:详细(默认)/ 精简。三处字数 + 二次总结的比例区间随档位一并切换。
 * 仅作用于内置模板的 {{summary_words}} / {{resummary_words}} / {{target_min}} / {{target_max}} 宏;
 * {{target}} 作为旧自定义模板的兼容宏,等同于 {{target_max}}。用户自填模板里若使用这些宏也会按档位填充。
 */
interface VerbosityProfile {
  summaryWords: string; // 摘要字数范围(填进 {{summary_words}})
  /** 摘要硬上限(字符,含标点),填进 {{summary_max_chars}};作为上限而非凑满目标 */
  summaryMaxChars: number;
  resummaryWords: string; // 普通总结字数范围(填进 {{resummary_words}})
  resummary2MinRatio: number; // 二次总结最低字数 = 输入总字数 × 最低比例
  resummary2MaxRatio: number; // 二次总结最高字数 = 输入总字数 × 最高比例
}
const VERBOSITY_PROFILES: Record<Verbosity, VerbosityProfile> = {
  detailed: {
    summaryWords: '150-300',
    summaryMaxChars: 360,
    resummaryWords: '300-500',
    resummary2MinRatio: 0.4,
    resummary2MaxRatio: 0.5,
  },
  concise: {
    summaryWords: '80-150',
    summaryMaxChars: 180,
    resummaryWords: '150-300',
    resummary2MinRatio: 0.3,
    resummary2MaxRatio: 0.4,
  },
};

/** 取当前生效的字数档位配置(读 apiSettings.verbosity,非法值兜底详细)。 */
function currentVerbosity(): VerbosityProfile {
  return VERBOSITY_PROFILES[apiSettings.verbosity] ?? VERBOSITY_PROFILES.detailed;
}

/**
 * 自定义摘要模板不会自动继承内置模板新增的字段,故单独发送最小兼容协议。
 * 这样老用户无需手动重置模板,也能开始产出 protagonist 增量。
 */
const PROTAGONIST_PROTOCOL_SUPPLEMENT = `【柏宝书主角档案兼容协议】
无论上方自定义模板是否提到本协议,最终 JSON 根对象都允许按需包含 protagonist:
{
  "protagonist": {
    "gender": "性别/性别表现",
    "identity": "当前身份/职业/种族/公开地位",
    "appearance": "当前稳定外貌/身体特征",
    "outfit": "当前完整着装",
    "condition": "当前身体状态/健康"
  }
}
字段省略表示保持旧值;空字符串表示明确清空旧值。

${RULE_PROTAGONIST}`;

/** 自定义摘要可能没用 {{time_field}}/{{time_rule}},无标签楼仍须强制产出锚点字段。 */
const TIME_ANCHOR_PROTOCOL_SUPPLEMENT = `【柏宝书时间锚点兼容协议】
本轮正文没有可读取的时间标签。无论上方自定义模板是否提到时间,最终 JSON 根对象都必须包含:
{
  "timeStart": "本段开始时的完整故事内时间",
  "timeEnd": "本段结束时的完整故事内时间"
}
两字段均不得省略;若本段时间没有推进,写相同的完整时间。

${RULE_COMPLETE_TIME_ANCHOR}`;

/** 自定义摘要可能没提局势卡;补充 sceneFocus 字段协议(可选字段,不破坏旧模板)。 */
const SCENE_FOCUS_PROTOCOL_SUPPLEMENT = `【柏宝书互动局势卡兼容协议】
最终 JSON 根对象可增加一个可选字段(没有实质变化就不要输出它):
{
  "sceneFocus": { "situation": "当前局面一句话", "participants": ["在场参与者名"], "tension": "互动张力(可选,高门槛)", "pendingBeat": "正文明确预告的即将发生之事(可选,禁预测)" }
}
省略表示保持上一张;写 null 表示明确清空。

${RULE_SCENE_FOCUS}`;

/** 自定义摘要可能没提生活小档案;补充 lifeDetails 字段协议(可选字段,不破坏旧模板)。 */
const LIFE_DETAILS_PROTOCOL_SUPPLEMENT = `【柏宝书生活小档案兼容协议】
本协议更新旧模板的“仅主角”限制:现支持主角及主要角色,必须明确人物归属,其他事实准入门槛不变。
最终 JSON 根对象可增加一个可选字段(没有可记的就不要输出它):
{
  "lifeDetails": {
    "add": [{ "subject": "user或主要角色在NPC名册中的确切名字", "text": "该人物明说过/正文明确揭示的偏好、习惯或近期状态一句话", "topics": ["主题标签"], "anchors": ["原文关键词"], "until": "故事内到期时间(长期偏好留空,可选)" }],
    "update": [{ "id": "d1", "subject": "明确纠正归属时才填;省略保持", "text": "纠正后的新内容(可选)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }
}

${RULE_LIFE_DETAILS}`;

/** 当前是否在用内置摘要模板(空=内置;等于内置默认也算内置)。用于「仅内置才启用」的解析校验。 */
export function isBuiltinSummaryPrompt(): boolean {
  const custom = apiSettings.prompts.summary.trim();
  return !custom || custom === SUMMARY_PROMPT.trim();
}

/** 内置规则与材料分别展开;自定义模板不猜测边界,只将兼容规范移到 system。 */
export function buildSummaryPrompt(a: BuildArgs): { system: string; user: string } {
  const custom = apiSettings.prompts.summary.trim();
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    history_block: a.history.trim() || '(无,这是开篇)',
    state_time: a.time || '(未知)',
    state_location: a.location || '(未知)',
    protagonist_block: fmtProtagonist(a.protagonist),
    items_block: fmtItems(a.items),
    itemlog_block: fmtItemLog(a.itemLog),
    scenes_block: fmtScenes(a.scenes),
    npcs_block: fmtNpcs(a.npcs),
    plans_block: fmtPlans(a.openPlans),
    resolved_plans_block: fmtResolvedPlans(a.resolvedPlans),
    scenefocus_block: fmtSceneFocus(a.sceneFocus),
    lifedetails_block: `- 生活小档案(已记录,用编号 d1/d2… 指代;只读参考,勿重复记录 —— 见下方【生活小档案规则】):\n${fmtLifeDetails(a.lifeDetails, a.user || '主角')}\n`,
    lifedetails_field: LIFE_DETAILS_FIELD_TMPL,
    lifedetails_rule: `\n${RULE_LIFE_DETAILS}\n`,
    content: a.content,
    time_field: a.hasTimeTags ? TIME_FIELD_WITH_TAGS : TIME_FIELD_NO_TAGS,
    time_rule: a.hasTimeTags ? TIME_RULE_WITH_TAGS : TIME_RULE_NO_TAGS,
    summary_words: currentVerbosity().summaryWords,
    summary_max_chars: String(currentVerbosity().summaryMaxChars),
    // 自定义变量三处:未配置变量(空状态 + 空说明)时全为空串(零 token 开销,老用户行为不变)
    vars_state_block: hasVars(a)
      ? `- 自定义变量·当前状态(结算到此刻的 JSON,只读参考,严禁重复结算):\n${renderVarsState(a.varsState)}`
        + (a.varsMeaning.trim() ? `\n- 变量含义(各字段是什么):\n${a.varsMeaning.trim()}` : '')
        + (a.varsRule.trim() ? `\n- 变量变化规则(何时怎么改/可否新建):\n${a.varsRule.trim()}` : '')
      : '',
    vars_field: hasVars(a) ? VARS_FIELD_TMPL : '',
    vars_rule: hasVars(a) ? `\n${RULE_VARS}\n` : '',
    // 供自定义模板单独取用的原始块
    vars_block: renderVarsState(a.varsState),
    varlog_block: [a.varsMeaning.trim(), a.varsRule.trim()].filter(Boolean).join('\n\n') || '(无)',
  };
  if (isBuiltinSummaryPrompt()) {
    return { system: fill(SUMMARY_RULES, macros), user: fill(SUMMARY_INPUT, macros) };
  }
  const prompt = fill(custom, macros);
  const supplements = [PROTAGONIST_PROTOCOL_SUPPLEMENT, RULE_ABSOLUTE_TIME_LANGUAGE, SCENE_FOCUS_PROTOCOL_SUPPLEMENT];
  supplements.push(LIFE_DETAILS_PROTOCOL_SUPPLEMENT);
  if (!prompt.includes('【内心好感与外在态度规则】')) supplements.push(RULE_NPC_AFFINITY);
  // 关系线保留:自定义模板未带入时补上,保证慢热互动不在摘要/压缩里被删空(与内置模板同源)
  if (!prompt.includes('【关系线保留】')) supplements.push(RULE_RELATION_MOMENTUM);
  // {{time_rule}} 在无时间标签时本身已经带有完整时间协议;
  // 只有自定义模板没有带入它时,才追加兼容协议,避免完整时间要求重复注入。
  if (!a.hasTimeTags && !prompt.includes('【完整时间锚点格式(系统强制)】')) {
    supplements.push(TIME_ANCHOR_PROTOCOL_SUPPLEMENT);
  }
  return {
    system: fill(supplements.join('\n\n'), macros),
    user: `${prompt}\n\n【主角当前档案(本轮之前,只读参考)】\n${macros.protagonist_block}`
      + (prompt.includes(macros.npcs_block) ? '' : `\n\n【已登场NPC(本轮之前,好感估计只作基线,不重复结算)】\n${macros.npcs_block}`)
      + (prompt.includes(macros.lifedetails_block.trim()) ? '' : `\n\n${macros.lifedetails_block}`),
  };
}

/** 是否启用了自定义变量(有当前状态或说明)。 */
function hasVars(a: BuildArgs): boolean {
  return Object.keys(a.varsState).length > 0 || a.varsMeaning.trim().length > 0 || a.varsRule.trim().length > 0;
}

/** vars 字段的 JSON 模板片段(接在 plans 之后,故带前导逗号)。命令数组,见【自定义变量规则】。 */
const VARS_FIELD_TMPL = `,
  "vars": [ { "op": "set|add|assign|remove", "path": "点/括号路径", "key": "assign/remove 用(可选)", "value": "set/assign 用(可选)", "delta": "add 用的数字(可选)" } ]`;

/** 生活小档案字段的 JSON 模板片段(接在 plans 之后,故带前导逗号)。 */
const LIFE_DETAILS_FIELD_TMPL = `,
  "lifeDetails": {
    "add": [{ "subject": "user或主要角色在NPC名册中的确切名字", "text": "该人物明说过/正文明确揭示的偏好、习惯或近期状态一句话", "topics": ["主题标签,1-3个"], "anchors": ["原文关键词"], "until": "故事内到期时间(长期偏好留空,可选)" }],
    "update": [{ "id": "d1", "subject": "明确纠正归属时才填;省略保持", "text": "纠正后的新内容(可选)", "topics": ["新标签(可选,整体覆盖)"], "anchors": ["新关键词(可选,整体覆盖)"], "until": "新时效(可选;空字符串=清除)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }`;

/**
 * 批量摘要的参数。批量只产 summary + 起止时间,故不传物品/计划(避免多楼顺序错乱)——
 * 只保留时间/地点/前情作只读背景,帮 AI 推算时间、理解场景。
 */
export interface BatchBuildArgs {
  user: string;
  char: string;
  /** 这批楼层开头之前的已知时间(只读背景,帮 AI 推算各楼时间) */
  time: string;
  /** 这批楼层开头之前的已知地点(只读背景) */
  location: string;
  history: string;
  /** 多楼拼接正文(每楼前带「━━ 第 n 楼 ━━」分隔) */
  content: string;
  /** 本批楼数(= floors 数组应有长度) */
  floorCount: number;
}

/** 构造批量摘要提示词。用户自定义模板(prompts.summary)不作用于批量——批量用内置 BATCH_SUMMARY_PROMPT。 */
export function buildBatchSummaryPrompt(a: BatchBuildArgs): { system: string; user: string } {
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    history_block: a.history.trim() || '(无,这是开篇)',
    state_time: a.time || '(未知)',
    state_location: a.location || '(未知)',
    content: a.content,
    floor_count: String(a.floorCount),
    summary_words: currentVerbosity().summaryWords,
  };
  return { system: fill(BATCH_SUMMARY_RULES, macros), user: fill(BATCH_SUMMARY_INPUT, macros) };
}

/** 填充批量思考清单里的 {{floor_count}} 宏。 */
export function buildBatchThinking(floorCount: number): string {
  return fill(BATCH_THINKING_CHECKLIST, { floor_count: String(floorCount) });
}

/**
 * 二次总结字数区间:详细为内容总字数的 40%–50%,精简为 30%–40%。
 */
export function resummary2Targets(contentLen: number): { min: number; max: number } {
  const v = currentVerbosity();
  return {
    min: Math.round(contentLen * v.resummary2MinRatio),
    max: Math.round(contentLen * v.resummary2MaxRatio),
  };
}

/**
 * 构造总结提示词。按层级分两套:
 *  - level<=1(L0 叶子 → L1):普通总结,固定字数 → RESUMMARY_PROMPT。
 *  - level>=2(L1+ → 更上层):二次总结,目标字数随输入规模动态给 → RESUMMARY2_PROMPT。
 * 各自优先用对应的自定义模板,空则回退内置。字数随档位(详细/精简)切换。
 */
export function buildResummaryPrompt(
  a: Pick<BuildArgs, 'user' | 'char' | 'content'> & { level: number },
): { system: string; user: string } {
  const isSecond = a.level >= 2;
  const custom = isSecond
    ? apiSettings.prompts.resummary2.trim()
    : apiSettings.prompts.resummary.trim();
  const builtin = isSecond ? RESUMMARY2_PROMPT : RESUMMARY_PROMPT;
  const targets = isSecond ? resummary2Targets(a.content.length) : { min: 0, max: 0 };
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    content: a.content,
    resummary_words: currentVerbosity().resummaryWords,
    target_min: isSecond ? String(targets.min) : '',
    target_max: isSecond ? String(targets.max) : '',
    // 兼容保存过旧版 {{target}} 的自定义模板;旧语义对应目标/最高字数。
    target: isSecond ? String(targets.max) : '',
  };
  if (custom && custom !== builtin.trim()) {
    const supplements = [RULE_ABSOLUTE_TIME_LANGUAGE];
    if (!custom.includes('【关系线保留】')) supplements.push(RULE_RELATION_MOMENTUM);
    return { system: supplements.join('\n\n'), user: fill(custom, macros) };
  }
  return {
    system: fill(isSecond ? RESUMMARY2_RULES : RESUMMARY_RULES, macros),
    user: fill(isSecond ? RESUMMARY2_INPUT : RESUMMARY_INPUT, macros),
  };
}

/**
 * 把用户人设(persona)包成独立 system 消息(摘要需据此理解「主角是谁」,
 * 正确写 summary、判断 NPC 与主角的互动)。空人设时调用方应跳过。
 * 字段已由调用方(fetchUserPersona)展开宏;这里只描述它是「主角本人设定」,与角色卡区分。
 */
/** 资料包装模板(09):固定措辞 + 动态资料占位,直接取自原文,避免手抄走样。 */
const DATA_WRAPPERS = (() => {
  const out: Record<string, string> = {};
  for (const block of dataWrappersRaw.split(/\n\s*\n(?=【)/)) {
    const name = block.match(/^【([^】]+)】/)?.[1];
    if (name) out[name] = block.replace(/〔[^〕]*〕[\s\S]*$/, '').replace(/\s+$/, '');
  }
  return out;
})();
function dataWrapper(prefix: string): string {
  const want = prefix.replace(/^【/, '');
  const key = Object.keys(DATA_WRAPPERS).find(k => k.startsWith(want));
  return key ? DATA_WRAPPERS[key] : '';
}

export function buildPersonaSystem(persona: string): string {
  return `${dataWrapper('【主角设定')}\n\n${persona.trim()}`;
}

/** 把世界书设定包成独立 system 消息的内容(空设定时调用方应跳过) */
export function buildWorldInfoSystem(worldInfo: string): string {
  return `${dataWrapper('【世界设定')}\n\n${worldInfo.trim()}`;
}

/**
 * 把角色卡描述包成独立 system 消息(有些卡人设写在角色描述而非世界书里,摘要也需据此理解角色)。
 * 字段已由调用方展开宏并按非空拼好;空则调用方应跳过本块。
 */
export function buildCharCardSystem(charCard: string): string {
  return `${dataWrapper('【角色设定')}\n\n${charCard.trim()}`;
}

/* ============ 思维链(机制照搬 Horae,字段适配 BaiBai 的 JSON) ============ */

/**
 * 「输出前思考」检查清单,作为 system 提示压在 user_input 之后。
 * 思考点对齐 Horae(本楼核心事件→物品清点→悬念清算→收笔位置→格式自检),
 * 但字段名/格式全部对齐 BaiBai 的 JSON(summary/time/location/items/plans),不提 <horae> 标签。
 */
export const THINKING_CHECKLIST = protocolSection('THINKING_CHECKLIST');

/** 与批量清单一样在发送前展开宏,不把占位符留给渠道处理。 */
export function buildSummaryThinking(user: string): string {
  return fill(THINKING_CHECKLIST, { user: user || '主角' });
}

/* ============ 向量召回:查询重写(Query Rewrite) ============ */

/** 查询重写可用的宏(供设置页展示) */
export const QUERY_REWRITE_MACROS: PromptMacro[] = [
  { token: '{{history_block}}', desc: '历史剧情摘要(已注入为前置上下文)' },
  { token: '{{state_snapshot}}', desc: '状态快照(滚出窗口的物品/计划)' },
];

/**
 * 查询重写系统提示词(复刻 Horae,用户已优化版)。
 * 让小模型把「最近剧情 + 状态」重写成 INTENT + 多条检索 Q,供向量召回多路检索 + RRF 融合。
 */
export const QUERY_REWRITE_SYSTEM = `你是角色扮演续写场景中的上下文规划器。

背景:
用户正在和AI进行角色扮演对话。对话历史中的assistant消息是AI扮演角色的回复。用户的消息是用户扮演角色的行为、台词或指令(如"继续""剧情推进")。
你的下游有一个向量数据库,存储着所有已经发生过的历史剧情片段。
你的任务是:判断AI续写下一段剧情时可能需要哪些历史信息,生成检索查询去召回这些信息。

核心原则:
你不是在分析"用户想查什么"。用户的消息是角色的台词或行为,不是搜索请求。
你要思考的是:AI接下来要续写这段剧情,它可能需要参考哪些已经发生过的事件、设定、关系、伏笔,才能写得连贯、准确、丰富?
然后为这些内容生成检索查询。
你无法知道数据库中实际存储了什么。因此你的策略是尽可能多角度覆盖,让召回成功的概率最大化。召回为空没有成本,漏掉关键信息会导致续写出错。

工作流程:

第一步:理解当前场景
从最近几轮对话中提取:
- 当前的时间、地点、在场人物
- 正在进行的事件或对话话题
- 人物当前的情绪状态和行为动向
- 如果用户发出的是推进指令(如"继续""剧情推进"),判断剧情即将进入什么阶段

第二步:识别续写可能涉及的历史依赖
思考AI续写时,哪些不在当前对话窗口中的历史信息可能被需要。从以下所有维度展开思考:
- 当前话题涉及的过去事件,对话中只提了一句但缺少细节的
- 即将进入的场景或地点,过去是否有过相关描写、事件、设定
- 在场人物之间的关系发展史、过去的关键互动
- 涉及人物的能力、习惯、性格特征的历史表现
- 已经埋下但尚未解决的伏笔、悬念、未完成的事件线
- 世界观设定中与当前情节相关的规则或背景
- 当前对话中出现的物品、地名、组织名等专有名词的历史出处
- 人物之间可能存在的、与当前情绪或话题相关的过往经历

第三步:生成检索查询
- 固定生成5条查询
- 用自然语言短句,接近小说叙事或剧情概述的风格
- 每条查询指向一个明确且不同的召回目标
- 5条查询必须覆盖尽可能多的不同维度:事件经过、人物关系、能力设定、环境描写、伏笔线索、情感历史、世界观背景等
- 包含具体的人名、地名、事件名,不要使用代词
- 不要复述当前对话窗口中已经完整呈现的内容(AI已经能看到这些),查询应指向窗口之外可能存在的信息
- 所有查询只能指向过去已经发生的事,不要推测尚未发生的事件

查询角度参考(每次从中选取最相关的5个方向):
- 当前话题背后的历史事件细节
- 相关人物过去在类似场景下的行为模式
- 即将进入的地点或场景的已有描写和事件
- 人物之间的关系史和关键转折点
- 能力系统、魔法规则、世界观设定中的相关约束
- 当前情绪状态的历史成因
- 对话中提及的物品或线索的来源和背景
- 已埋下的伏笔和悬而未决的事件线
- 与当前事件模式相似的过往事件

禁止事项:
- 不要回答用户的问题或续写剧情
- 不要解释你的推理过程
- 不要编造上下文中没有依据的人物、事件或设定
- 不要生成指向未来尚未发生事件的查询
- 不要重复召回相同或高度相似的内容

INTENT的写法要求:
- 用一段自然语言描述当前场景的核心信息,包含具体的人名、地名、事件、人物状态和关系
- 风格接近剧情摘要或小说叙事,不要使用元叙事用语(如"剧情即将进入""阶段""推进")
- 目的是在精排阶段作为全文匹配的上下文,因此要尽可能覆盖当前场景涉及的关键实体和事实
- 包含当前窗口中与检索相关的核心事实,让精排模型能判断候选片段与当前情境的关联程度
- 长度2到4句话

输出格式:
第一行以 INTENT: 开头,按上述要求写当前场景描述。
之后恰好5行,每行以 Q: 开头,写一条检索查询。
不要输出任何其他内容。

---

示例1:

对话背景:陆远舟在天渊城被暗杀昏迷,苏晚宁赶到后一直在照顾他。最近一轮assistant写到苏晚宁在客栈翻看陆远舟的随身物品,发现一封被撕碎的信。用户最新消息是苏晚宁把碎片拼起来试图辨认字迹。

输出:
INTENT: 苏晚宁在天渊城客栈中拼凑陆远舟随身携带的碎信,试图辨认字迹和寄信人。陆远舟此前在天渊城遭暗杀陷入昏迷,苏晚宁赶到后一直守在他身边照顾并开始调查暗杀真相。
Q: 陆远舟在天渊城被暗杀前与哪些人有过书信往来
Q: 陆远舟抵达天渊城的原因和他此行的目的
Q: 天渊城中与陆远舟有过接触或敌对关系的势力和人物
Q: 苏晚宁与陆远舟之间的关系发展和信任变化历程
Q: 陆远舟过去是否有过隐瞒身份或秘密行动的记录

示例2:

对话背景:两人在教室里,期末考试前一周,角色A对角色B说"这次应该能考好吧",语气有点心虚。

输出:
INTENT: 期末考试前一周,角色A在教室里对角色B说"这次应该能考好吧",语气心虚。角色A似乎对自己的考试表现缺乏信心。
Q: 角色A过去的考试成绩记录和学业表现
Q: 角色A和角色B在过去考试期间的互动和共同经历
Q: 角色A在学业上是否遭遇过挫折或受到过压力
Q: 角色B对角色A学习能力或态度的看法和过往评价
Q: 角色A最近的学习状态和备考行为的相关描写

示例3:

对话背景:木白白和user讨论了多个地点出现恶魔的帖子,确认的场公园比鸡山更早出现异常,木白白提到自己从未遇到过其他魔法少女。当前场景是两人在玄关准备出门前往的场公园踩点。用户最新消息是"剧情推进"。

输出:
INTENT: 木白白和user在玄关准备出门前往的场公园,调查近期多地出现的恶魔袭击事件。木白白昨晚在鸡山战斗后已补充魔力,但她从未遇到过其他魔法少女,只能独自应对。的场公园的异常记录早于鸡山,两处恶魔可能存在关联。
Q: 的场公园过去发生的异常事件和恶魔目击报告的具体描述
Q: 木白白在鸡山与恶魔战斗时恶魔的外形特征和攻击行为
Q: 木白白的变身形态、武器、魔力上限等战斗能力的已知设定
Q: 木白白的魔力补充方式和补充后恢复状态的具体描写
Q: 恶魔最近在不同地点扩散的时间规律和活动范围变化`;

/** 查询重写收尾提示词(放在对话末尾再强调一次任务与格式) */
export const QUERY_REWRITE_TAIL = `记住你的任务:
- 你是上下文规划器,不是角色扮演者,不要续写剧情
- 思考AI续写下一段需要参考哪些已发生的历史信息
- 所有查询只能指向过去已经发生的事
- 不要查询当前对话窗口中已经完整呈现的内容
- 严格按格式输出:一行INTENT加恰好5行Q,不要输出任何其他内容`;