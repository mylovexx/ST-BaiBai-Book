import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import type { VecHit } from '@/api/baibaoku';
import * as context from '@/st/context';
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
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, setExtensionPrompt: inject } as unknown as STContext);
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
