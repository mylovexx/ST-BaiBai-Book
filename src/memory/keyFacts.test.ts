import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as client from '@/api/client';
import * as context from '@/st/context';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import { deleteLeafAt, deleteSummary, deleteSummarySubtrees, editKeyFactsAt, editLeafAt, editLeafFull, getLeaf, pruneBrokenComps } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { checkResummary, currentSummaryPromise, engineState, regenerateFloor, summarizeFloor, summarizeSelected } from './engine';
import { buildHistoryInjectionText, buildSummaryView, estimateInjectionTokenBreakdown, refreshInjection, renderHistoryNodes, renderHistoryNodesWithRelative, selectHistoryNodesBefore, selectInjectionNodes } from './inject';
import { cleanKeyFacts, getKeyFactSource, getMessageKeyFacts, renderKeyFacts, writeMessageKeyFacts } from './keyFacts';
import { buildResummaryPrompt } from './prompts';
import { derivedMeta, loadMemory, memory, recomputeDerived, saveMemory } from './store';
import { createEmptyMemory, type MemSummary, type SummaryKeyFact } from './types';

const original = {
  prompts: { ...settings.apiSettings.prompts },
  leafBatchThreshold: settings.apiSettings.leafBatchThreshold,
  leafKeepRecent: settings.apiSettings.leafKeepRecent,
  resummaryThreshold: settings.apiSettings.resummaryThreshold,
  higherResummaryThreshold: settings.apiSettings.higherResummaryThreshold,
  summaryMaxRetries: settings.apiSettings.summaryMaxRetries,
  keepRecent: settings.apiSettings.keepRecent,
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  vectorEnabled: settings.apiSettings.vector.enabled,
};
const fact = (id = 'fact-a', text = '  约定11月20日18:00前归还1200元。\n第二行 <tag>原样</tag>  '): SummaryKeyFact => ({ id, text });
const message = (id: string, active = true): STMessage => ({
  name: '艾琳', is_user: false, is_system: active, mes: `原文 ${id}。`,
  extra: {
    bbs_hidden: active || undefined,
    bbs_leaf: { id, text: `摘要 ${id}。`, delta: {}, createdAt: 1, swipe: 0, v: 1,
      timeStart: '2026/11/1 15:00', timeEnd: '2026/11/1 16:00' },
  },
});
const comp = (id: string, childIds: string[], level = 1): MemSummary => ({
  id, childIds, level, text: `总结 ${id}。`, createdAt: level + 1, auto: true,
});
function useChat(chat: STMessage[]): STContext {
  const ctx = {
    chat, chatMetadata: {}, name1: '主角', name2: '艾琳', getCurrentChatId: () => 'facts-chat',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    setExtensionPrompt: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
function attach(message: STMessage, facts = [fact()]) {
  expect(writeMessageKeyFacts(message, facts, getLeaf(message))).toBe(true);
}
function occurrences(text: string, value: string) { return text.split(value).length - 1; }

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  Object.assign(engineState, { lastError: '', running: false });
  Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
  Object.assign(settings.apiSettings, { leafBatchThreshold: 0, leafKeepRecent: 0, resummaryThreshold: 0,
    higherResummaryThreshold: 0, summaryMaxRetries: 0, keepRecent: 1, summaryOnlyMode: false });
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '模型简写后的叙事正文。', keyFacts: ['模型改写的事实'] }));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings.prompts, original.prompts);
  const { prompts: _prompts, vectorEnabled, ...rest } = original;
  Object.assign(settings.apiSettings, rest);
  settings.apiSettings.vector.enabled = vectorEnabled;
});

describe('关键事实原文与节点尾部', () => {
  it('保存/载入保留空格、数字、标点、标签和换行,窗口内摘要提前注入', () => {
    const first = message('a', false);
    const ctx = useChat([first, message('b', false)]);
    expect(estimateInjectionTokenBreakdown().summary).toBe(0);
    expect(editLeafAt(0, '正文。', '', '', [fact(), fact('blank', ' \n ')])).toBe(true);
    const nodes = selectInjectionNodes(memory.summaries, ctx.chat);
    expect(nodes.map(node => node.id)).toEqual(['a']);
    expect(renderHistoryNodes(nodes)).toBe(`正文。\n\n【关键事实】\n${fact().text}`);
    expect(renderHistoryNodesWithRelative(nodes, '')).toBe(renderHistoryNodes(nodes));
    expect(estimateInjectionTokenBreakdown().summary).toBeGreaterThan(0);
    saveMemory();
    ctx.chat = JSON.parse(JSON.stringify(ctx.chat));
    loadMemory();
    expect(getMessageKeyFacts(ctx.chat[0])).toEqual([fact()]);
    expect(derivedMeta.leaves[0]?.keyFacts).toEqual([fact()]);
  });

  it('继承按来源楼层与摘要内顺序排列,只按 id 去重', () => {
    const a = message('a'), b = message('b');
    attach(a, [fact('a1', '同文事实'), fact('a2', '第二条')]);
    attach(b, [fact('b1', '同文事实')]);
    const ctx = useChat([a, b]);
    memory.summaries.push(comp('l1', ['b', 'a', 'a']), comp('l2', ['l1', 'a'], 2));
    const node = buildSummaryView(memory.summaries, ctx.chat).byId.get('l2')!;
    expect(node.keyFacts?.map(value => value.id)).toEqual(['a1', 'a2', 'b1']);
    expect(occurrences(renderHistoryNodes([node]), '同文事实')).toBe(2);
    expect(cleanKeyFacts([fact(), fact(), { id: 'invalid', text: 10 }])).toEqual([fact()]);
  });

  it('深层事实修改/删除立即反映到已有祖先,不修改总结正文', () => {
    const a = message('a'); attach(a);
    const ctx = useChat([a]);
    memory.summaries.push(comp('l1', ['a']), comp('l2', ['l1'], 2), comp('l3', ['l2'], 3));
    const before = memory.summaries.map(node => node.text);
    expect(editKeyFactsAt(0, [fact('fact-a', '纠正后:金额1200元,原样。')])).toBe(true);
    expect(selectInjectionNodes(memory.summaries, ctx.chat)[0]?.keyFacts?.[0]?.text).toBe('纠正后:金额1200元,原样。');
    expect(editKeyFactsAt(0, [])).toBe(true);
    expect(buildHistoryInjectionText()).not.toContain('【关键事实】');
    expect(memory.summaries.map(node => node.text)).toEqual(before);
    expect(getLeaf(a)?.text).toBe('摘要 a。');
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('部分窗口拆分与历史截止不带入未来来源,每条事实仅注入一次', () => {
    const a = message('a'), b = message('b', false);
    attach(a, [fact('a', '过去事实')]); attach(b, [fact('b', '窗口事实')]);
    const ctx = useChat([a, b]);
    memory.summaries.push(comp('root', ['a', 'b']));
    expect(selectInjectionNodes(memory.summaries, ctx.chat).map(node => node.id)).toEqual(['a', 'b']);
    const injected = buildHistoryInjectionText();
    expect(occurrences(injected, '过去事实')).toBe(1);
    expect(occurrences(injected, '窗口事实')).toBe(1);
    const before = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, ctx.chat, 1));
    expect(before).toContain('过去事实');
    expect(before).not.toContain('窗口事实');
    b.is_system = true;
    expect(selectInjectionNodes(memory.summaries, ctx.chat).map(node => node.id)).toEqual(['root']);
    expect(occurrences(buildHistoryInjectionText(), '窗口事实')).toBe(1);
  });
});

describe('摘要删除与事实删除独立', () => {
  it('删摘要保留事实并可单独修改/删除,最后一条删除后清空提示槽', () => {
    const a = message('a'); attach(a);
    a.swipe_info = [{ extra: JSON.parse(JSON.stringify(a.extra)) }];
    const ctx = useChat([a]);
    expect(deleteLeafAt(0)).toBe(true);
    expect(a.extra?.bbs_leaf).toBeUndefined();
    expect(a.swipe_info[0]?.extra?.bbs_leaf).toBeUndefined();
    expect(getMessageKeyFacts(a)).toEqual([fact()]);
    expect(derivedMeta.leaves[0]).toMatchObject({ id: 'a', factsOnly: true, keyFacts: [fact()] });
    expect(derivedMeta.hasLeaf).toBe(false);
    expect(renderHistoryNodes(selectInjectionNodes([], ctx.chat))).toContain(fact().text);
    expect(editKeyFactsAt(0, [fact('new', '没有摘要时不允许新增')])).toBe(false);
    expect(editKeyFactsAt(0, [fact('fact-a', '已有事实的修改。')])).toBe(true);
    expect(a.extra?.bbs_leaf).toBeUndefined();
    expect(editKeyFactsAt(0, [])).toBe(true);
    refreshInjection();
    expect(derivedMeta.leaves).toHaveLength(0);
    const calls = vi.mocked(ctx.setExtensionPrompt!).mock.calls.filter(call => call[0] === 'baibai_book_memory_history');
    expect(calls.at(-1)?.[1]).toBe('');
    expect(a.extra?.bbs_key_facts).toBeUndefined();
    expect(a.swipe_info[0]?.extra?.bbs_key_facts).toBeUndefined();
  });

  it('拆掉总结以及删除整棵子树都保留来源事实,重新载入仍可见', () => {
    const a = message('a'), b = message('b'); attach(a); attach(b, [fact('b', '另一条事实')]);
    const ctx = useChat([a, b]);
    memory.summaries.push(comp('root', ['a', 'b']));
    expect(deleteSummary('root')).toBe(true);
    expect(getMessageKeyFacts(a)).toEqual([fact()]);
    memory.summaries.push(comp('root2', ['a', 'b']));
    expect(deleteSummarySubtrees(['root2'])).toMatchObject({ leaves: 2, summaries: 1 });
    expect(ctx.chat.every(value => !value.extra?.bbs_leaf)).toBe(true);
    ctx.chat = JSON.parse(JSON.stringify(ctx.chat));
    loadMemory();
    expect(derivedMeta.leaves).toHaveLength(2);
    const nodes = selectInjectionNodes(memory.summaries, ctx.chat);
    expect(nodes.every(node => node.factsOnly)).toBe(true);
    expect(renderHistoryNodes(nodes)).toContain(fact().text);
    expect(renderHistoryNodes(nodes)).toContain('另一条事实');
  });

  it('删后重新补摘使用原来源 id,事实不会被模型输出覆盖', async () => {
    const a = message('a', false); attach(a); useChat([a]);
    deleteLeafAt(0);
    await summarizeFloor(0);
    expect(getLeaf(a)?.id).toBe('a');
    expect(getLeaf(a)?.text).toBe('模型简写后的叙事正文。');
    expect(getMessageKeyFacts(a)).toEqual([fact()]);
    expect(getKeyFactSource(a)?.leafId).toBe('a');
  });

  it('重新摘要期间修改的事实保留最新值,时间/结构化编辑也不丢事实', async () => {
    const a = message('a', false); attach(a); useChat([a]);
    vi.mocked(client.requestViaMainApi).mockImplementation(async () => {
      editKeyFactsAt(0, [fact('fact-a', '请求期间保存的新原文。')]);
      return JSON.stringify({ summary: '新正文。', keyFacts: ['错误事实'] });
    });
    expect(await regenerateFloor(0)).toBe(true);
    expect(getMessageKeyFacts(a)[0]?.text).toBe('请求期间保存的新原文。');
    expect(editLeafFull(0, { text: '手改正文。', timeStart: '2026/11/2', timeEnd: '', delta: {} })).toBe(true);
    expect(getMessageKeyFacts(a)[0]?.text).toBe('请求期间保存的新原文。');
    expect(getKeyFactSource(a)?.timeStart).toBe('2026/11/2');
  });

  it('swipe 不串页且保留旧森林,番外只暂停投放', () => {
    const a = message('a'), b = message('b'); attach(a); attach(b, [fact('b', '旁支事实')]);
    const ctx = useChat([a, b]);
    memory.summaries.push(comp('root', ['a', 'b']));
    a.swipe_info = [{ extra: JSON.parse(JSON.stringify(a.extra)) }, { extra: {} }];
    a.swipe_id = 1;
    a.extra = JSON.parse(JSON.stringify(a.swipe_info[0]?.extra));
    delete a.extra!.bbs_leaf;
    expect(getMessageKeyFacts(a)).toEqual([]);
    expect(pruneBrokenComps()).toBe(false);
    expect(buildHistoryInjectionText()).not.toContain(fact().text);
    a.swipe_id = 0;
    a.extra = a.swipe_info[0]?.extra;
    expect(selectInjectionNodes(memory.summaries, ctx.chat).map(node => node.id)).toEqual(['root']);
    expect(buildHistoryInjectionText()).toContain(fact().text);
    a.extra!.bbs_omit = true;
    expect(buildHistoryInjectionText()).not.toContain(fact().text);
    expect(getMessageKeyFacts(a)).toEqual([fact()]);
    delete a.extra!.bbs_omit;
    expect(buildHistoryInjectionText()).toContain(fact().text);
  });
});

describe.each(['automatic', 'manual'] as const)('各级压缩原文保留 (%s)', mode => {
  it.each([0, 1, 2])('模型仅返回简写正文,输出 L%s 的上一层仍有原文尾部', async inputLevel => {
    const a = message('a'), b = message('b'); attach(a); attach(b, [fact('b', '另一来源的事实。')]);
    const ctx = useChat([a, b]);
    let ids = ['a', 'b'];
    for (let level = 1; level <= inputLevel; level++) {
      const next = ids.map((id, i) => comp(`l${level}-${i}`, [id], level));
      memory.summaries.push(...next);
      ids = next.map(node => node.id);
    }
    Object.assign(settings.apiSettings, { leafBatchThreshold: 2, resummaryThreshold: 2, higherResummaryThreshold: 2, keepRecent: 0 });
    const made = mode === 'automatic' ? await checkResummary() : (await summarizeSelected(ids)).made;
    expect(made).toBe(1);
    const saved = memory.summaries.at(-1)!;
    expect(saved).toMatchObject({ text: '模型简写后的叙事正文。', level: inputLevel + 1, childIds: ids });
    expect(saved).not.toHaveProperty('keyFacts');
    const prompt = vi.mocked(client.requestViaMainApi).mock.calls[0]?.[0].map(value => value.content).join('\n') ?? '';
    expect(prompt).toContain(fact().text);
    expect(prompt).toContain('人工关键事实');
    const rendered = renderHistoryNodes(selectInjectionNodes(memory.summaries, ctx.chat));
    expect(rendered).toContain(`模型简写后的叙事正文。\n\n【关键事实】\n${fact().text}`);
    expect(occurrences(rendered, fact().text)).toBe(1);
    expect(rendered).not.toContain('模型改写的事实');
    expect(getMessageKeyFacts(a)).toEqual([fact()]);
  });
});

describe('压缩预算与携带', () => {
  it.each([false, true])('事实参考不影响 L2+ 正文目标字数,自定义=%s', custom => {
    useChat([]);
    if (custom) settings.apiSettings.prompts.resummary2 = '{{content}}\n预算 {{target_min}}-{{target_max}}';
    const args = { user: '主角', char: '艾琳', content: '叙事正文。'.repeat(80), level: 2 };
    const plain = buildResummaryPrompt(args);
    const withFacts = buildResummaryPrompt({ ...args, keyFacts: renderKeyFacts([fact('long', '长事实。'.repeat(1000))]) });
    expect(withFacts.user.startsWith(plain.user)).toBe(true);
    expect(withFacts.system).toContain('字数预算仅约束叙事正文');
  });

  it.each([false, true])('携带时历史事实放种子来源、窗口事实随消息,历史仅事实=%s', factsOnly => {
    const a = message('a'), b = message('b'), c = message('c', false);
    attach(a); attach(c, [fact('window', '窗口事实原文。')]);
    const source = useChat([a, b, c]);
    if (factsOnly) { deleteLeafAt(0); deleteLeafAt(1); }
    const before = JSON.stringify(source.chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'facts-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    return createNewChatWithCarryover().then(ok => {
      expect(ok).toBe(true);
      expect(JSON.stringify(source.chat)).toBe(before);
      const seed = target.chat[0]!;
      expect(getMessageKeyFacts(seed)).toEqual([fact()]);
      expect(seed.extra?.bbs_leaf?.text).not.toContain('【关键事实】');
      expect(seed.extra?.bbs_leaf?.text).not.toContain(fact().text);
      expect(getMessageKeyFacts(target.chat.at(-1))).toEqual([fact('window', '窗口事实原文。')]);
      const rendered = buildHistoryInjectionText();
      expect(occurrences(rendered, fact().text)).toBe(1);
      expect(occurrences(rendered, '窗口事实原文。')).toBe(1);
      expect(editKeyFactsAt(0, [])).toBe(true);
      expect(target.chat[0]?.extra?.bbs_leaf).toBeDefined();
    });
  });
});
