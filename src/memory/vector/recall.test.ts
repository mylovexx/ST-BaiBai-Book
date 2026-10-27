import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import type { VecHit } from '@/api/baibaoku';
import * as context from '@/st/context';
import * as notices from '@/st/toast';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '../engine';
import * as embed from './embed';
import * as index from './index';
import * as rewrite from './rewrite';
import * as scope from './scope';
import * as store from './store';
import { RECALL_CACHE_STORAGE_KEY } from './cache';
import { recallDebug, resetRecallDebug, snapshotRecallDebug } from './debug';
import { runVectorRecall } from './recall';
import { prepareForcedRecallRound, readForcedRecallState, removeForcedRecall, selectForcedRecall } from '../forcedRecall';
import { MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from '../prompts';

const originalVector = JSON.parse(JSON.stringify(settings.apiSettings.vector));
const message = (isUser: boolean, mes: string, overrides: Partial<STMessage> = {}): STMessage => ({
  name: isUser ? 'User' : 'Character', is_user: isUser, is_system: false, mes, ...overrides,
});
const hits: VecHit[] = [
  { leafId: 'full', scope: 'chat:recall-test', similarity: 0.95, queryIndex: 0,
    document: '全文档的摘要。', mesFull: '需要召回的完整旧剧情。', storyTime: null, msgIndex: 0 },
  { leafId: 'brief', scope: 'chat:recall-test', similarity: 0.85, queryIndex: 0,
    document: '仅需召回的摘要。', mesFull: '摘要档不该发出的全文。', storyTime: null, msgIndex: 1 },
];
let chat: STMessage[];
let inject: ReturnType<typeof vi.fn>;
let ctx: STContext;

beforeEach(() => {
  settings.apiSettings.vector = JSON.parse(JSON.stringify(originalVector));
  Object.assign(settings.apiSettings.vector, { enabled: true, traditionalMode: true });
  Object.assign(settings.apiSettings.vector.recall, { minAiFloors: 0, rerankCandidates: 20,
    embeddingThreshold: 0.8, rerankThreshold: 0.9, fullTextCount: 1, finalRecallCount: 2 });
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  });
  chat = [message(false, '上一轮剧情。'), message(true, '她还记得当年的约定吗？'), message(false, '待重生成的回复。')];
  inject = vi.fn();
  ctx = { chat, chatMetadata: {}, getCurrentChatId: () => 'recall-test', setExtensionPrompt: inject,
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined) } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(scope, 'currentVectorDb').mockReturnValue('recall-db');
  vi.spyOn(scope, 'currentChatId').mockReturnValue('recall-test');
  vi.spyOn(scope, 'currentChatScope').mockReturnValue('chat:recall-test');
  vi.spyOn(scope, 'currentBundleHashes').mockReturnValue([]);
  vi.spyOn(scope, 'recallScopes').mockReturnValue(['chat:recall-test']);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(1);
  vi.spyOn(index, 'ensureRecallIndex').mockResolvedValue();
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(() => new Float32Array([1, 0])));
  vi.spyOn(embed, 'rerankDocuments').mockResolvedValue([{ index: 0, score: 0.95 }, { index: 1, score: 0.5 }]);
  vi.spyOn(store, 'vecSearch').mockResolvedValue({ results: hits });
  vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: '回忆当年的约定。', queries: ['曾经的约定', '她与主角的往事'] });
  resetRecallDebug();
});

describe('手动强制注入与向量合并', () => {
  async function choose(mode: 'summary' | 'full' = 'summary') {
    chat[0].extra = { bbs_leaf: { id: 'full', text: '手动选中的旧楼摘要', delta: {}, createdAt: 1, swipe: 0, v: 1 } };
    await selectForcedRecall(0, mode);
  }

  it.each(['disabled', 'unconfigured', 'window', 'floor count', 'empty input', 'no hits', 'rewrite failure', 'embedding failure', 'search failure'])(
    '向量%s时仍注入手动内容并记录详情', async scenario => {
      await choose();
      if (scenario === 'disabled') settings.apiSettings.vector.enabled = false;
      if (scenario === 'unconfigured') vi.mocked(scope.currentVectorDb).mockReturnValue(null);
      if (scenario === 'window') vi.mocked(engine.resolveKeepStart).mockReturnValue(0);
      if (scenario === 'floor count') settings.apiSettings.vector.recall.minAiFloors = 30;
      if (scenario === 'empty input') chat[1].mes = '  ';
      if (scenario === 'no hits') vi.mocked(store.vecSearch).mockResolvedValue({ results: [] });
      if (scenario === 'rewrite failure') {
        settings.apiSettings.vector.traditionalMode = false;
        vi.mocked(rewrite.rewriteQuery).mockRejectedValue(new Error('重写失败'));
      }
      if (scenario === 'embedding failure') vi.mocked(embed.embedTexts).mockRejectedValue(new Error('向量化失败'));
      if (scenario === 'search failure') vi.mocked(store.vecSearch).mockRejectedValue(new Error('检索失败'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await runVectorRecall();
      expect(inject.mock.calls.at(-1)?.[0]).toBe('baibai_book_vector_recall');
      expect(inject.mock.calls.at(-1)?.[1]).toContain('手动选中的旧楼摘要');
      expect(recallDebug.forced).toMatchObject([{ source: '#0', mode: 'summary', reason: '' }]);
      expect(recallDebug.injectedText).toContain('[强制注入]');
    });

  it('强制内容不挤占向量全文或最终名额,重复来源排除且包装只有一次', async () => {
    await choose('full');
    Object.assign(settings.apiSettings.vector.recall, { finalRecallCount: 1, fullTextCount: 1 });
    vi.mocked(store.vecSearch).mockResolvedValue({ results: [hits[0], { ...hits[1], similarity: 0.98 }] });
    vi.mocked(embed.rerankDocuments).mockResolvedValue([{ index: 0, score: 0.99 }]);
    await runVectorRecall();
    expect(store.vecSearch).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ excludeLeafIds: ['full'] }));
    const text = recallDebug.injectedText;
    expect(text).toContain(chat[0].mes);
    expect(text).toContain(hits[1].mesFull);
    expect(text).not.toContain(hits[0].mesFull);
    expect(text.split(MEMORY_BRIEFING_NOTE)).toHaveLength(2);
    expect(text.split(MEMORY_BRIEFING_END)).toHaveLength(2);
    expect(text.indexOf('[强制注入]')).toBeLessThan(text.indexOf('[相关回忆]'));
    expect(recallDebug.rerank).toMatchObject([{ leafId: 'brief', tier: 'full' }]);
  });

  it('同轮重roll复用缓存,修改手动模式和来源正文后重新计算', async () => {
    await choose();
    await runVectorRecall();
    const text = recallDebug.injectedText;
    chat[2].mes = '新的swipe回复';
    await runVectorRecall();
    expect(embed.embedTexts).toHaveBeenCalledOnce();
    expect(recallDebug.injectedText).toBe(text);
    await selectForcedRecall(0, 'full');
    await runVectorRecall();
    expect(embed.embedTexts).toHaveBeenCalledTimes(2);
    chat[0].mes = '更新的来源正文';
    await runVectorRecall();
    expect(embed.embedTexts).toHaveBeenCalledTimes(3);
    expect(recallDebug.injectedText).toContain('更新的来源正文');
  });

  it('新轮、显式清空和总开关关闭都不残留上一轮手动内容', async () => {
    await choose();
    settings.apiSettings.vector.enabled = false;
    await runVectorRecall();
    await removeForcedRecall();
    await runVectorRecall();
    expect(recallDebug.injectedText).toBe('');
    await selectForcedRecall(0, 'summary');
    await runVectorRecall();
    chat.push(message(true, '新一轮输入'));
    await runVectorRecall();
    expect(recallDebug.forced).toEqual([]);
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
    await selectForcedRecall(0, 'full');
    vi.mocked(settings.engineActiveHere).mockReturnValue(false);
    await runVectorRecall();
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
    expect(readForcedRecallState().pending).toHaveLength(1);
  });

  it.each(['omit', 'swipe', 'deleted'])('来源%s后跳过并显示原因', async scenario => {
    await choose();
    await prepareForcedRecallRound();
    if (scenario === 'omit') chat[0].extra!.bbs_omit = true;
    if (scenario === 'swipe') chat[0].swipe_id = 1;
    if (scenario === 'deleted') chat.shift();
    settings.apiSettings.vector.enabled = false;
    await runVectorRecall();
    expect(recallDebug.forced[0].reason).toBeTruthy();
    expect(recallDebug.injectedText).toBe('');
  });

  it('不把待重生成的当前回复当作来源', async () => {
    await selectForcedRecall(2, 'full');
    settings.apiSettings.vector.enabled = false;
    await runVectorRecall();
    expect(recallDebug.forced[0].reason).toContain('正在重生成');
    expect(recallDebug.injectedText).toBe('');
  });

  it('无效手动来源不会经旧向量索引回退成另一种模式注入', async () => {
    await choose();
    await prepareForcedRecallRound();
    chat[0].extra!.bbs_omit = true;
    vi.mocked(embed.rerankDocuments).mockResolvedValue([{ index: 0, score: 0.5 }]);
    await runVectorRecall();
    expect(recallDebug.forced[0].reason).toContain('番外');
    expect(recallDebug.injectedText).not.toContain(hits[0].mesFull);
    expect(recallDebug.injectedText).not.toContain('手动选中的旧楼摘要');
    expect(recallDebug.injectedText).toContain(hits[1].document);
  });

  it('取消召回清空共享槽,保留该轮组合供下一次重试', async () => {
    await choose();
    const controller = new AbortController();
    vi.mocked(index.ensureRecallIndex).mockImplementationOnce(async () => { controller.abort(); });
    await runVectorRecall(controller.signal);
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
    expect(recallDebug.injectedText).toBe('');
    expect(readForcedRecallState().history).toHaveLength(1);
    expect(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)).toBeNull();
    await runVectorRecall();
    expect(recallDebug.injectedText).toContain('手动选中的旧楼摘要');
  });

  it('绑定保存失败显示实际错误,保留草稿供重试', async () => {
    await choose();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notice = vi.spyOn(notices, 'toast').mockImplementation(() => {});
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('服务器保存失败'));
    await runVectorRecall();
    expect(recallDebug.status).toContain('服务器保存失败');
    expect(recallDebug.injectedText).toBe('');
    expect(readForcedRecallState().pending).toHaveLength(1);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('选择已保留'), 'error');
    await runVectorRecall();
    expect(recallDebug.injectedText).toContain('手动选中的旧楼摘要');
  });

  it('召回等待期间切聊天,不写入旧聊天内容或缓存', async () => {
    await choose();
    let finish!: () => void;
    vi.mocked(store.vecSearch).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ results: hits }); }));
    const running = runVectorRecall();
    await vi.waitFor(() => expect(store.vecSearch).toHaveBeenCalledOnce());
    const nextInject = vi.fn();
    vi.mocked(context.getContext).mockReturnValue({ ...ctx, chat: [], chatMetadata: {}, setExtensionPrompt: nextInject });
    vi.mocked(scope.currentChatId).mockReturnValue('another-chat');
    finish();
    await running;
    expect(nextInject.mock.calls.at(-1)?.[1]).toBe('');
    expect(inject.mock.calls.some(call => call[1].includes('手动选中'))).toBe(false);
    expect(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)).toBeNull();
  });

  it('召回等待期间来源变成番外,不发旧内容且不保存过期缓存', async () => {
    await choose();
    let finish!: () => void;
    vi.mocked(store.vecSearch).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ results: hits }); }));
    const running = runVectorRecall();
    await vi.waitFor(() => expect(store.vecSearch).toHaveBeenCalledOnce());
    chat[0].extra!.bbs_omit = true;
    finish();
    await running;
    expect(recallDebug.injectedText).toBe('');
    expect(recallDebug.forced[0].reason).toContain('番外');
    expect(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)).toBeNull();
  });
});

afterEach(() => {
  settings.apiSettings.vector = JSON.parse(JSON.stringify(originalVector));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('traditional vector recall', () => {
  it('passes the complete latest user input to embedding and rerank without requiring rewrite configuration', async () => {
    const raw = `  <scene>她回到故地。</scene>\n${'详细描述当年的约定。'.repeat(40)}\n现在又见到了那个人。  `;
    chat[1].mes = raw;
    chat.push(message(false, '系统提示。', { is_system: true }));
    chat.push(message(true, '标为 user 的系统提示。', { is_system: true }));
    settings.apiSettings.vector.queryRewrite.model = '';
    settings.apiSettings.vector.queryRewrite.url = '';
    const signal = new AbortController().signal;

    await runVectorRecall(signal);

    expect(rewrite.rewriteQuery).not.toHaveBeenCalled();
    expect(embed.embedTexts).toHaveBeenCalledExactlyOnceWith([raw.trim()], signal);
    expect(embed.rerankDocuments).toHaveBeenCalledExactlyOnceWith(raw.trim(), hits.map(h => h.mesFull), 2, signal);
    expect(store.vecSearch).toHaveBeenCalledWith('recall-db', ['chat:recall-test'], [expect.any(String)], {
      topK: 20, excludeLeafIds: [],
    });
    expect(recallDebug).toMatchObject({ queryMode: 'traditional', intent: '', queries: [raw.trim()], status: '召回完成' });
    expect(recallDebug.rerank.map(h => h.tier)).toEqual(['full', 'brief']);
    expect(recallDebug.injectedText).toContain(hits[0].mesFull);
    expect(recallDebug.injectedText).toContain(hits[1].document);
    expect(recallDebug.injectedText).not.toContain(hits[1].mesFull);
  });

  it.each(['empty chat', 'no user', 'blank latest user'] as const)('clears stale injection without falling back (%s)', async scenario => {
    recallDebug.injectedText = '上一回合的召回。';
    if (scenario === 'empty chat') chat.splice(0);
    if (scenario === 'no user') chat.splice(1, 1);
    if (scenario === 'blank latest user') chat.push(message(true, ' \n\t '));

    await runVectorRecall();

    expect(index.ensureRecallIndex).not.toHaveBeenCalled();
    expect(rewrite.rewriteQuery).not.toHaveBeenCalled();
    expect(embed.embedTexts).not.toHaveBeenCalled();
    expect(store.vecSearch).not.toHaveBeenCalled();
    expect(embed.rerankDocuments).not.toHaveBeenCalled();
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
    expect(recallDebug).toMatchObject({ queryMode: 'traditional', queries: [], injectedText: '' });
    expect(recallDebug.status).toBe(scenario === 'blank latest user' ? '未召回:本轮用户输入为空' : '未召回:无用户输入');
  });

  it('restores the actual mode and query from cache when regenerating or swiping the last AI reply', async () => {
    await runVectorRecall();
    const debug = snapshotRecallDebug();
    const text = recallDebug.injectedText;
    chat[2].mes = '翻页后的新回复。';
    chat[2].swipe_id = 1;
    resetRecallDebug('rewrite');

    await runVectorRecall();

    expect(embed.embedTexts).toHaveBeenCalledOnce();
    expect(index.ensureRecallIndex).toHaveBeenCalledOnce();
    expect(embed.rerankDocuments).toHaveBeenCalledOnce();
    expect(inject.mock.calls.at(-1)?.[1]).toBe(text);
    expect(recallDebug).toMatchObject({ ...debug, status: '召回完成(复用缓存)' });
  });

  it('recomputes when switching modes in either direction', async () => {
    settings.apiSettings.vector.traditionalMode = false;
    await runVectorRecall();
    const rewriteKey = JSON.parse(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)!).key;
    expect(embed.embedTexts).toHaveBeenLastCalledWith(['曾经的约定', '她与主角的往事'], undefined);
    expect(embed.rerankDocuments).toHaveBeenLastCalledWith('回忆当年的约定。', expect.any(Array), 2, undefined);

    settings.apiSettings.vector.traditionalMode = true;
    await runVectorRecall();
    expect(JSON.parse(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)!).key).not.toBe(rewriteKey);
    expect(embed.embedTexts).toHaveBeenLastCalledWith([chat[1].mes], undefined);
    expect(recallDebug).toMatchObject({ queryMode: 'traditional', intent: '', queries: [chat[1].mes] });

    settings.apiSettings.vector.traditionalMode = false;
    await runVectorRecall();
    expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
    expect(embed.embedTexts).toHaveBeenCalledTimes(3);
    expect(recallDebug).toMatchObject({ queryMode: 'rewrite', intent: '回忆当年的约定。', queries: ['曾经的约定', '她与主角的往事'] });
  });

  it('invalidates the cache after editing the latest input or recall thresholds', async () => {
    await runVectorRecall();
    chat[1].mes = '她忘记了当年的约定吗？';
    await runVectorRecall();
    expect(embed.embedTexts).toHaveBeenLastCalledWith([chat[1].mes], undefined);
    settings.apiSettings.vector.recall.embeddingThreshold = 0.9;
    await runVectorRecall();
    expect(embed.embedTexts).toHaveBeenCalledTimes(3);
    expect(recallDebug.rerank.map(h => h.tier)).toEqual(['full', 'drop']);
  });

  it('keeps the mode and user input captured before waiting for the index', async () => {
    let finishIndex!: () => void;
    vi.mocked(index.ensureRecallIndex).mockImplementationOnce(() => new Promise<void>(resolve => { finishIndex = resolve; }));
    const originalInput = chat[1].mes;
    const pending = runVectorRecall();
    await vi.waitFor(() => expect(index.ensureRecallIndex).toHaveBeenCalledOnce());
    settings.apiSettings.vector.traditionalMode = false;
    chat[1].mes = '索引等待期间编辑的输入。';
    finishIndex();
    await pending;

    expect(rewrite.rewriteQuery).not.toHaveBeenCalled();
    expect(embed.embedTexts).toHaveBeenLastCalledWith([originalInput], undefined);
    expect(recallDebug.queryMode).toBe('traditional');
    await runVectorRecall();
    expect(rewrite.rewriteQuery).toHaveBeenCalledOnce();
    expect(recallDebug.queryMode).toBe('rewrite');
  });

  it.each(['window', 'floor count'] as const)('still respects the existing recall gate (%s)', async gate => {
    if (gate === 'window') vi.mocked(engine.resolveKeepStart).mockReturnValue(0);
    else settings.apiSettings.vector.recall.minAiFloors = 30;
    await runVectorRecall();
    expect(embed.embedTexts).not.toHaveBeenCalled();
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
  });

  it('keeps the existing embedding fallback when rerank fails', async () => {
    vi.mocked(embed.rerankDocuments).mockRejectedValue(new Error('Rerank unavailable'));
    await runVectorRecall();
    expect(recallDebug.status).toBe('召回完成');
    expect(recallDebug.rerank.map(h => h.tier)).toEqual(['full', 'brief']);
  });

  it('ends rewrite recall on failure without silently switching modes or caching the failure', async () => {
    settings.apiSettings.vector.traditionalMode = false;
    vi.mocked(rewrite.rewriteQuery).mockRejectedValue(new Error('Query 重写未配置'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runVectorRecall();
    await runVectorRecall();
    expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
    expect(embed.embedTexts).not.toHaveBeenCalled();
    expect(localStorage.getItem(RECALL_CACHE_STORAGE_KEY)).toBeNull();
    expect(inject.mock.calls.at(-1)?.[1]).toBe('');
    expect(recallDebug).toMatchObject({ queryMode: 'rewrite', status: '失败:Query 重写未配置' });
  });
});
