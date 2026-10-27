import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick } from 'vue';
import * as context from '@/st/context';
import * as settings from '@/api/settings';
import { engineState, isAiFloor } from '@/memory/engine';
import { memory, recomputeDerived } from '@/memory/store';
import { createEmptyMemory, type LeafExtra } from '@/memory/types';
import type { STContext, STMessage } from '@/st/context';
import { availableFavoriteTags, captureFavoriteTarget, collectFavorites, favoriteBody, favoriteSaving, favorites, favoriteTargetCurrent, normalizeTags, readFavorite, removeFavorite, saveFavorite } from './store';

const message = (extra: STMessage['extra'] = {}): STMessage => ({
  name: '角色', is_user: false, is_system: false, mes: '剧情正文', extra,
});
const leaf = (): LeafExtra => ({
  id: 'leaf-0', text: '已有楼层摘要', createdAt: 0, v: 1, swipe: 0,
  delta: { items: { add: [{ name: '钥匙' }] } },
});
let ctx: STContext;
let chatId: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  engineState.running = false;
  chatId = '收藏测试';
  ctx = {
    chat: [message()], chatMetadata: {}, name1: '用户', name2: '角色',
    getCurrentChatId: () => chatId,
    saveChat: vi.fn().mockResolvedValue(undefined),
    eventSource: { on: vi.fn() }, eventTypes: {},
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(false);
  recomputeDerived();
});

afterEach(() => {
  engineState.running = false;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function target(floor = 0) {
  return captureFavoriteTarget(floor)!;
}

describe('收藏读取与分类', () => {
  it('旧番外直接显示,不改写原消息且保留已有摘要预览', () => {
    const extra = { bbs_omit: true, bbs_leaf: leaf() };
    const rows = collectFavorites([message(extra)]);
    expect(rows).toMatchObject([{ floor: 0, title: '楼层 #0', tags: ['番外'], summary: '已有楼层摘要', summaryState: 'ready' }]);
    expect(extra).not.toHaveProperty('bbs_favorite');
  });

  it('按楼层倒序,支持未分类以及多个标签', () => {
    const chat = [message({ bbs_favorite: { title: '起点', tags: [] } }), message(), message({ bbs_favorite: { tags: ['里程碑', '重逢'] } })];
    const rows = collectFavorites(chat);
    expect(rows.map(row => row.floor)).toEqual([2, 0]);
    expect(rows.filter(row => row.tags.includes('重逢')).map(row => row.floor)).toEqual([2]);
    expect(rows.filter(row => !row.tags.length).map(row => row.floor)).toEqual([0]);
  });

  it('忽略用户楼、原生系统楼及内部提示楼', () => {
    const favorite = { bbs_favorite: { tags: [] } };
    expect(collectFavorites([
      { ...message(favorite), is_user: true },
      { ...message({ ...favorite, type: 'narrator' }), is_system: true },
      message({ ...favorite, bbs_internal_notice: 'backlog' }),
    ])).toEqual([]);
  });

  it('清理空白和重复标签,兼容异常字段并避免重复保存番外', () => {
    expect(normalizeTags([' 重逢 ', '', 3, '重逢', '里程碑'])).toEqual(['重逢', '里程碑']);
    expect(readFavorite(message({ bbs_favorite: { title: ' 标题 ', tags: ['番外', '番外', '重逢'] } }))).toEqual({ title: '标题', tags: ['重逢'] });
    expect(readFavorite(message({ bbs_favorite: '坏数据' } as unknown as STMessage['extra']))).toBeNull();
  });

  it('没有摘要与翻页失效分别提示,不返回其他 swipe 的摘要', () => {
    const chat = [message({ bbs_favorite: { tags: [] } }), { ...message({ bbs_favorite: { tags: [] }, bbs_leaf: leaf() }), swipe_id: 1 }];
    expect(collectFavorites(chat)).toMatchObject([
      { floor: 1, summary: '', summaryState: 'stale' },
      { floor: 0, summary: '', summaryState: 'missing' },
    ]);
  });

  it('已隐藏的真实 AI 楼仍能收藏,空摘要有单独提示', () => {
    const hidden = { ...message({ bbs_hidden: true, bbs_favorite: { tags: [] }, bbs_leaf: { ...leaf(), text: '' } }), is_system: true };
    expect(collectFavorites([hidden])).toMatchObject([{ floor: 0, summaryState: 'empty' }]);
  });

  it('正文预览复用清洗规则,不包含正文之外的状态栏', () => {
    const text = '状态栏前缀<bbs_start>2026/10/27 10:00</bbs_start>正文\n第二行<bbs_end>2026/10/27 10:05</bbs_end>状态栏尾部';
    expect(favoriteBody({ ...message(), mes: text })).toContain('正文\n第二行');
    expect(favoriteBody({ ...message(), mes: text })).not.toContain('状态栏');
  });

  it('正文预览随共享清洗标签即时更新,保留未配置标签和原消息', () => {
    const previousTags = settings.apiSettings.customStripTags;
    const original = '正文\n<snow class="status">隐藏状态栏</snow><雪>隐藏旁注</雪>\n<content>保留正文</content>';
    const floor = { ...message(), mes: original };
    try {
      settings.apiSettings.customStripTags = [];
      const body = computed(() => favoriteBody(floor));
      expect(body.value).toContain('隐藏状态栏');
      settings.apiSettings.customStripTags.push('snow', '雪');
      expect(body.value).toBe('正文\n\n<content>保留正文</content>');
      settings.apiSettings.customStripTags = [];
      expect(body.value).toBe(original);
      expect(floor.mes).toBe(original);
    } finally {
      settings.apiSettings.customStripTags = previousTags;
    }
  });
});

describe('收藏保存与番外联动', () => {
  it('没有摘要也能收藏,标题与多标签写入服务器聊天', async () => {
    await saveFavorite(target(), { title: ' 初次相遇 ', tags: ['里程碑', ' 重逢 ', '重逢'] });
    expect(ctx.chat[0].extra?.bbs_favorite).toEqual({ title: '初次相遇', tags: ['里程碑', '重逢'] });
    expect(ctx.chat[0].extra?.bbs_omit).toBeUndefined();
    expect(ctx.saveChat).toHaveBeenCalledOnce();
    expect(isAiFloor(ctx.chat[0])).toBe(true);
    expect(availableFavoriteTags.value).toEqual(['番外', '里程碑', '重逢']);
  });

  it('可修改并清空标题,保留未分类收藏', async () => {
    await saveFavorite(target(), { title: '旧标题', tags: ['旧标签'] });
    await saveFavorite(target(), { title: '   ', tags: [] });
    expect(ctx.chat[0].extra?.bbs_favorite).toEqual({ tags: [] });
    expect(favorites.value[0].title).toBe('楼层 #0');
  });

  it('聊天保存后重新载入,标题和标签仍在', async () => {
    let saved = '';
    vi.mocked(ctx.saveChat).mockImplementation(async () => { saved = JSON.stringify(ctx.chat); });
    await saveFavorite(target(), { title: '跨设备收藏', tags: ['里程碑', '重逢'] });
    ctx.chat = JSON.parse(saved) as STMessage[];
    recomputeDerived();
    expect(favorites.value).toMatchObject([{ title: '跨设备收藏', tags: ['里程碑', '重逢'] }]);
  });

  it('保存期间拒绝并发写入,结束后释放状态', async () => {
    let finish: () => void = () => {};
    vi.mocked(ctx.saveChat).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const firstSave = saveFavorite(target(), { title: '第一次保存', tags: [] });
    expect(favoriteSaving.value).toBe(true);
    await expect(saveFavorite(target(), { title: '第二次保存', tags: [] })).rejects.toThrow('正在保存收藏');
    finish();
    await firstSave;
    expect(favoriteSaving.value).toBe(false);
    expect(ctx.chat[0].extra?.bbs_favorite?.title).toBe('第一次保存');
  });

  it('普通收藏不改变摘要及派生记忆', async () => {
    const original = leaf();
    ctx.chat[0].extra = { bbs_leaf: original };
    recomputeDerived();
    expect(memory.items.map(item => item.name)).toEqual(['钥匙']);
    await saveFavorite(target(), { title: '拿到钥匙', tags: ['里程碑', '道具'] });
    expect(ctx.chat[0].extra.bbs_leaf).toBe(original);
    expect(memory.items.map(item => item.name)).toEqual(['钥匙']);
  });

  it('番外排除记忆,移除标签恢复原叶子及派生状态', async () => {
    ctx.chat[0].extra = { bbs_leaf: leaf() };
    const original = ctx.chat[0].extra.bbs_leaf;
    await saveFavorite(target(), { title: '小剧场', tags: ['番外', '重逢'] });
    expect(ctx.chat[0].extra.bbs_omit).toBe(true);
    expect(ctx.chat[0].extra.bbs_favorite?.tags).toEqual(['重逢']);
    expect(isAiFloor(ctx.chat[0])).toBe(false);
    expect(memory.items).toEqual([]);
    await saveFavorite(target(), { title: '主线重逢', tags: ['重逢'] });
    expect(ctx.chat[0].extra.bbs_omit).toBeUndefined();
    expect(ctx.chat[0].extra.bbs_leaf).toBe(original);
    expect(memory.items.map(item => item.name)).toEqual(['钥匙']);
  });

  it('取消普通收藏移除记录,取消番外收藏保留番外分类', async () => {
    await saveFavorite(target(), { title: '标题', tags: ['重逢'] });
    await removeFavorite(target());
    expect(favorites.value).toEqual([]);
    await saveFavorite(target(), { title: '番外标题', tags: ['番外', '重逢'] });
    await removeFavorite(target());
    expect(ctx.chat[0].extra?.bbs_favorite).toBeUndefined();
    expect(ctx.chat[0].extra?.bbs_omit).toBe(true);
    expect(favorites.value).toMatchObject([{ title: '楼层 #0', tags: ['番外'] }]);
  });

  it('同步已有 swipe 备份,翻回旧页保留收藏,取消也同步', async () => {
    const firstExtra = { bbs_leaf: leaf() };
    ctx.chat[0].swipe_info = [{ extra: firstExtra }, { extra: { other_plugin: '保留' } }];
    await saveFavorite(target(), { title: '重逢', tags: ['里程碑'] });
    ctx.chat[0].extra = ctx.chat[0].swipe_info[0].extra;
    recomputeDerived();
    expect(favorites.value).toMatchObject([{ title: '重逢', tags: ['里程碑'] }]);
    await removeFavorite(target());
    expect(ctx.chat[0].swipe_info.map(info => info.extra?.bbs_favorite)).toEqual([undefined, undefined]);
    expect(ctx.chat[0].swipe_info[1].extra?.other_plugin).toBe('保留');
    expect(ctx.chat[0].extra?.bbs_leaf).toEqual(leaf());
  });

  it('摘要删除和重新生成不影响收藏', async () => {
    await saveFavorite(target(), { title: '收藏标题', tags: ['重逢'] });
    ctx.chat[0].extra!.bbs_leaf = leaf();
    recomputeDerived();
    expect(favorites.value[0].summary).toBe('已有楼层摘要');
    delete ctx.chat[0].extra!.bbs_leaf;
    recomputeDerived();
    expect(favorites.value[0]).toMatchObject({ title: '收藏标题', summaryState: 'missing' });
    ctx.chat[0].extra!.bbs_leaf = { ...leaf(), id: '重新生成', text: '新的摘要' };
    recomputeDerived();
    expect(favorites.value[0]).toMatchObject({ title: '收藏标题', tags: ['重逢'], summary: '新的摘要' });
  });

  it('摘要运行时允许普通收藏,拒绝更改番外', async () => {
    engineState.running = true;
    await saveFavorite(target(), { title: '', tags: ['里程碑'] });
    await expect(saveFavorite(target(), { title: '', tags: ['番外'] })).rejects.toThrow('摘要正在生成');
    expect(ctx.chat[0].extra?.bbs_favorite?.tags).toEqual(['里程碑']);
  });

  it('服务器保存失败时恢复收藏与番外状态', async () => {
    ctx.chat[0].extra = { bbs_leaf: leaf(), bbs_favorite: { title: '原标题', tags: ['里程碑'] } };
    vi.mocked(ctx.saveChat).mockRejectedValueOnce(new Error('保存失败'));
    await expect(saveFavorite(target(), { title: '新标题', tags: ['番外'] })).rejects.toThrow('保存失败');
    expect(ctx.chat[0].extra.bbs_favorite).toEqual({ title: '原标题', tags: ['里程碑'] });
    expect(ctx.chat[0].extra.bbs_omit).toBeUndefined();
    expect(memory.items.map(item => item.name)).toEqual(['钥匙']);
    expect(favoriteSaving.value).toBe(false);
  });
});

describe('收藏跟随消息与聊天校验', () => {
  it('删掉前面的楼层后重新读取当前楼层号,陈旧编辑目标不能保存', async () => {
    ctx.chat.unshift(message());
    await saveFavorite(target(1), { title: '目标楼', tags: [] });
    const oldTarget = target(1);
    ctx.chat.shift();
    recomputeDerived();
    expect(favorites.value).toMatchObject([{ floor: 0, title: '目标楼' }]);
    await expect(saveFavorite(oldTarget, { title: '错误写入', tags: [] })).rejects.toThrow('聊天或楼层已变化');
    expect(ctx.chat[0].extra?.bbs_favorite?.title).toBe('目标楼');
  });

  it('切换聊天拒绝旧目标,新聊天及欢迎页不显示残留收藏', async () => {
    await saveFavorite(target(), { title: '旧聊天', tags: [] });
    const oldTarget = target();
    chatId = '新聊天';
    ctx.chat = [message()];
    recomputeDerived();
    expect(favorites.value).toEqual([]);
    expect(favoriteTargetCurrent(oldTarget)).toBe(false);
    await expect(removeFavorite(oldTarget)).rejects.toThrow('聊天或楼层已变化');
    ctx.chat = [oldTarget.message];
    chatId = undefined;
    recomputeDerived();
    expect(favorites.value).toEqual([]);
  });

  it('非楼层索引不能捕获目标', () => {
    expect(captureFavoriteTarget(-1)).toBeNull();
    expect(captureFavoriteTarget(0.5)).toBeNull();
    expect(captureFavoriteTarget(10)).toBeNull();
  });

  it('响应式列表在楼层外部编辑后更新', async () => {
    await saveFavorite(target(), { title: '旧标题', tags: [] });
    ctx.chat[0].extra!.bbs_favorite!.title = '外部修改';
    recomputeDerived();
    await nextTick();
    expect(favorites.value[0].title).toBe('外部修改');
  });
});
