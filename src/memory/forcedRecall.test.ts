import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { apiSettings } from '@/api/settings';
import { engineState } from './engine';
import type { LeafExtra } from './types';
import { FORCED_RECALL_KEY, forcedRecallHistory, forcedRecallRunning, forcedRecallSaving, forcedRecallSelection,
  inspectForcedRecall, prepareForcedRecallRound, readForcedRecallState, removeForcedRecall,
  resolveForcedMessage, reuseForcedRecall, selectForcedRecall } from './forcedRecall';

const leaf = (): LeafExtra => ({ id: 'leaf-source', text: '旧楼摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 });
const message = (isUser: boolean, mes: string, extra?: STMessage['extra']): STMessage => ({
  name: isUser ? '用户' : '角色', is_user: isUser, is_system: false, mes, extra,
});
let ctx: STContext;
const originalTags = [...apiSettings.customStripTags];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  engineState.running = false;
  ctx = {
    chat: [message(false, '旧楼正文', { bbs_leaf: leaf() }), message(true, '当前输入'), message(false, '当前回复')],
    chatMetadata: {}, getCurrentChatId: () => 'forced-test',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
});
afterEach(() => {
  forcedRecallRunning.value = false;
  apiSettings.customStripTags = [...originalTags];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('强制注入轮次与历史', () => {
  it('选择先保存草稿,生成绑定该轮,重roll保留,新轮不沿用', async () => {
    await selectForcedRecall(0, 'summary');
    const id = ctx.chat[0].extra!.bbs_force_id!;
    expect(readForcedRecallState().pending).toEqual([{ messageId: id, mode: 'summary' }]);
    expect(ctx.chat[1].extra?.bbs_forced_recall).toBeUndefined();
    expect(ctx.chatMetadata[FORCED_RECALL_KEY]).toBeDefined();
    expect(ctx.chat[0].extra?.bbs_favorite).toBeUndefined();

    const round = await prepareForcedRecallRound();
    expect(round?.entries).toEqual([{ messageId: id, mode: 'summary' }]);
    expect(readForcedRecallState().pending).toBeNull();
    ctx.chat[2].swipe_id = 1;
    expect(await prepareForcedRecallRound()).toEqual(round);
    expect(readForcedRecallState().history).toHaveLength(1);
    ctx.chat.push(message(true, '下一轮输入'));
    expect(await prepareForcedRecallRound()).toBeNull();
  });

  it('新选择能用于发送新消息后的生成,显式清空阻止同轮旧配置复活', async () => {
    await selectForcedRecall(0, 'full');
    ctx.chat.push(message(true, '新输入'));
    const round = await prepareForcedRecallRound();
    expect(ctx.chat[3].extra?.bbs_forced_recall).toEqual(round);
    expect(ctx.chat[1].extra?.bbs_forced_recall).toBeUndefined();
    await removeForcedRecall();
    expect(readForcedRecallState().pending).toEqual([]);
    expect((await prepareForcedRecallRound())?.entries).toEqual([]);
    expect((await prepareForcedRecallRound())?.entries).toEqual([]);
  });

  it('历史只保留最近10个轮次,同轮重roll更新而不新增', async () => {
    const rounds = [];
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(1000 + i);
      ctx.chat.push(message(true, `输入${i}`));
      await selectForcedRecall(0, 'summary');
      rounds.push((await prepareForcedRecallRound())!.roundId);
    }
    expect(readForcedRecallState().history.map(row => row.roundId)).toEqual(rounds.slice(2).reverse());
    expect(ctx.chat.filter(message => message.extra?.bbs_forced_recall)).toHaveLength(10);
    vi.setSystemTime(2000);
    await prepareForcedRecallRound();
    expect(readForcedRecallState().history).toHaveLength(10);
    expect(readForcedRecallState().history[0].at).toBe(2000);
  });

  it('历史合并保留已选项,同楼采用历史模式,跳过番外和已删来源', async () => {
    await selectForcedRecall(0, 'full');
    await prepareForcedRecallRound();
    const history = readForcedRecallState().history[0];
    ctx.chat.splice(1, 0, message(false, '另一楼正文'));
    await selectForcedRecall(1, 'full');
    await selectForcedRecall(0, 'summary');
    expect(await reuseForcedRecall(history.entries)).toBe(0);
    expect(readForcedRecallState().pending).toHaveLength(2);
    expect(readForcedRecallState().pending!.find(row => row.messageId === history.entries[0].messageId)?.mode).toBe('full');
    ctx.chat[0].extra!.bbs_omit = true;
    expect(await reuseForcedRecall([...history.entries, { messageId: 'deleted', mode: 'full' }])).toBe(2);
  });

  it('服务器数据重新载入后,草稿、轮次和历史仍可读取', async () => {
    await selectForcedRecall(0, 'summary');
    const reload = () => { ctx.chat = JSON.parse(JSON.stringify(ctx.chat)); ctx.chatMetadata = JSON.parse(JSON.stringify(ctx.chatMetadata)); };
    reload();
    expect((await prepareForcedRecallRound())?.entries[0].mode).toBe('summary');
    reload();
    expect((await prepareForcedRecallRound())?.entries[0].mode).toBe('summary');
    expect(readForcedRecallState().history).toHaveLength(1);
    expect(ctx.saveChat).toHaveBeenCalled();
    expect(ctx.saveMetadata).toHaveBeenCalled();
  });

  it('删除前楼或恢复swipe备份后仍指向同一物理来源', async () => {
    ctx.chat.unshift(message(false, '前楼'));
    const source = ctx.chat[1];
    source.swipe_info = [{ extra: { bbs_leaf: leaf() } }, { extra: { other_plugin: '保留' } }];
    await selectForcedRecall(1, 'full');
    const entry = readForcedRecallState().pending![0];
    ctx.chat.shift();
    expect(inspectForcedRecall(entry).floor).toBe(0);
    source.extra = source.swipe_info[1].extra;
    source.swipe_id = 1;
    expect(resolveForcedMessage(entry.messageId)).toBe(source);
    expect(inspectForcedRecall(entry).body).toBe('旧楼正文');
    expect(source.extra?.other_plugin).toBe('保留');
    ctx.chat.shift();
    expect(inspectForcedRecall(entry).reason).toContain('已删除');
  });
});

describe('强制注入可用性与保存保护', () => {
  it('拒绝番外、系统楼和坏索引,缺摘要只允许原文', async () => {
    ctx.chat[0].extra!.bbs_omit = true;
    await expect(selectForcedRecall(0, 'full')).rejects.toThrow('番外');
    delete ctx.chat[0].extra!.bbs_omit;
    delete ctx.chat[0].extra!.bbs_leaf;
    await expect(selectForcedRecall(0, 'summary')).rejects.toThrow('暂无摘要');
    await selectForcedRecall(0, 'full');
    await expect(selectForcedRecall(1, 'full')).rejects.toThrow('来源楼层');
    await expect(selectForcedRecall(-1, 'full')).rejects.toThrow('来源楼层');
    await expect(selectForcedRecall(0.5, 'full')).rejects.toThrow('来源楼层');
  });

  it('读当前页摘要和共享清洗正文,不自动回退注入模式', async () => {
    await selectForcedRecall(0, 'summary');
    const entry = readForcedRecallState().pending![0];
    ctx.chat[0].swipe_id = 1;
    expect(inspectForcedRecall(entry)).toMatchObject({ body: '', reason: '当前翻页暂无有效摘要' });
    apiSettings.customStripTags = ['snow'];
    ctx.chat[0].mes = '正文<snow>不该注入</snow>';
    expect(inspectForcedRecall({ ...entry, mode: 'full' }).body).toBe('正文');
    expect(ctx.chat[0].mes).toContain('不该注入');
    ctx.chat[0].mes = '<snow>仅有状态栏</snow>';
    expect(inspectForcedRecall({ ...entry, mode: 'full' }).reason).toContain('正文为空');
  });

  it.each(['chat', 'metadata'])('保存%s失败回滚自己的字段,保留其他插件数据', async stage => {
    ctx.chat[0].extra!.other_plugin = '保留';
    vi.mocked(stage === 'chat' ? ctx.saveChat : ctx.saveMetadata).mockRejectedValueOnce(new Error('保存失败'));
    await expect(selectForcedRecall(0, 'full')).rejects.toThrow('保存失败');
    expect(ctx.chatMetadata[FORCED_RECALL_KEY]).toBeUndefined();
    expect(ctx.chat[0].extra).toEqual({ bbs_leaf: leaf(), other_plugin: '保留' });
    expect(ctx.chat[1].extra).toBeUndefined();
    expect(forcedRecallSaving.value).toBe(false);
  });

  it('保存失败不消耗草稿,可以重新绑定重试', async () => {
    await selectForcedRecall(0, 'full');
    const pending = readForcedRecallState().pending;
    vi.mocked(ctx.saveMetadata).mockRejectedValueOnce(new Error('保存失败'));
    await expect(prepareForcedRecallRound()).rejects.toThrow('保存失败');
    expect(readForcedRecallState().pending).toEqual(pending);
    expect(ctx.chat[1].extra?.bbs_forced_recall).toBeUndefined();
    expect((await prepareForcedRecallRound())?.entries).toEqual(pending);
  });

  it('保存期间拒绝并发操作,切聊天后不向新聊天保存旧配置', async () => {
    let finish!: () => void;
    const previous = ctx;
    vi.mocked(ctx.saveChat).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const saving = selectForcedRecall(0, 'full');
    await expect(selectForcedRecall(0, 'summary')).rejects.toThrow('正在保存');
    ctx = { ...ctx, chat: [message(false, '新聊天')], chatMetadata: {}, getCurrentChatId: () => 'another' };
    finish();
    await expect(saving).rejects.toThrow('聊天已变化');
    expect(previous.chatMetadata[FORCED_RECALL_KEY]).toBeUndefined();
    expect(ctx.chatMetadata[FORCED_RECALL_KEY]).toBeUndefined();
    expect(ctx.saveMetadata).not.toHaveBeenCalled();
  });

  it('生成准备期间拒绝调整,欢迎页不展示残留', async () => {
    forcedRecallRunning.value = true;
    await expect(selectForcedRecall(0, 'full')).rejects.toThrow('生成准备');
    forcedRecallRunning.value = false;
    await selectForcedRecall(0, 'full');
    ctx.getCurrentChatId = () => undefined;
    // 响应式镜像也通过草稿写入的 revision 刷新。
    const { recomputeDerived } = await import('./store');
    recomputeDerived();
    expect(forcedRecallSelection.value.entries).toEqual([]);
    expect(forcedRecallHistory.value).toEqual([]);
  });
});
