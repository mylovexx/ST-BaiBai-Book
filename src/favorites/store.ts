import { computed, ref } from 'vue';
import { getContext, type STMessage } from '@/st/context';
import { getLeaf, leafValid } from '@/memory/apply';
import { engineState, isRealAiReply, setFloorOmit } from '@/memory/engine';
import { derivedMeta, recomputeDerived } from '@/memory/store';
import { cleanBody } from '@/memory/timeTag';

export const EXTRA_TAG = '番外';
export const MILESTONE_TAG = '里程碑';

export interface FavoriteExtra {
  title?: string;
  /** 番外由 bbs_omit 决定,避免两份标记不同步。 */
  tags: string[];
}

export interface FavoriteTarget {
  chatId: string;
  floor: number;
  message: STMessage;
}

export interface FavoriteDraft {
  title: string;
  tags: string[];
}

export interface FavoriteView {
  floor: number;
  message: STMessage;
  title: string;
  tags: string[];
  summary: string;
  summaryState: 'ready' | 'missing' | 'stale' | 'empty';
}

const revision = ref(0);
export const favoriteSaving = ref(false);

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))];
}

export function readFavorite(message: STMessage | undefined): FavoriteExtra | null {
  const raw = message?.extra?.bbs_favorite;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return { ...(title ? { title } : {}), tags: normalizeTags(raw.tags).filter(tag => tag !== EXTRA_TAG) };
}

export function favoriteTags(message: STMessage | undefined): string[] {
  const tags = readFavorite(message)?.tags ?? [];
  return message?.extra?.bbs_omit ? [EXTRA_TAG, ...tags] : tags;
}

export function isFavorite(message: STMessage | undefined): boolean {
  return !!(readFavorite(message) || message?.extra?.bbs_omit);
}

export function collectFavorites(chat: STMessage[]): FavoriteView[] {
  const rows: FavoriteView[] = [];
  for (let floor = chat.length - 1; floor >= 0; floor--) {
    const message = chat[floor];
    if (!isRealAiReply(message) || !isFavorite(message)) continue;
    const leaf = getLeaf(message);
    const valid = leafValid(message);
    const summary = valid && typeof leaf?.text === 'string' ? leaf.text.trim() : '';
    rows.push({
      floor, message,
      title: readFavorite(message)?.title || `楼层 #${floor}`,
      tags: favoriteTags(message),
      summary,
      summaryState: !leaf ? 'missing' : !valid ? 'stale' : summary ? 'ready' : 'empty',
    });
  }
  return rows;
}

export const favorites = computed(() => {
  // chat 本身不响应式,同时追踪摘要重算与收藏写入。
  void derivedMeta.rev;
  void revision.value;
  const ctx = getContext();
  return ctx?.getCurrentChatId?.() ? collectFavorites(ctx.chat ?? []) : [];
});

export const availableFavoriteTags = computed(() => normalizeTags([
  EXTRA_TAG, MILESTONE_TAG, ...favorites.value.flatMap(row => row.tags),
]));

export function captureFavoriteTarget(floor: number): FavoriteTarget | null {
  const ctx = getContext();
  const chatId = ctx?.getCurrentChatId?.();
  const message = ctx?.chat?.[floor];
  return chatId && Number.isInteger(floor) && floor >= 0 && isRealAiReply(message)
    ? { chatId, floor, message: message! }
    : null;
}

export function favoriteTargetCurrent(target: FavoriteTarget): boolean {
  const ctx = getContext();
  return ctx?.getCurrentChatId?.() === target.chatId
    && ctx.chat?.[target.floor] === target.message && isRealAiReply(target.message);
}

export function favoriteBody(message: STMessage): string {
  // 与注入共用清洗入口,设置变更即时生效且不改写原消息。
  return cleanBody(typeof message.mes === 'string' ? message.mes : '');
}

function writeFavorite(message: STMessage, value: FavoriteExtra | null): void {
  const extras = [message.extra ??= {}, ...(message.swipe_info ?? []).flatMap(info => info ? [info.extra ??= {}] : [])];
  // 收藏属于楼层,同步已有 swipe 的备份,翻回旧页也能保留标题和普通标签。
  for (const extra of extras) {
    if (value) extra.bbs_favorite = { ...value, tags: [...value.tags] };
    else delete extra.bbs_favorite;
  }
}

async function persistFavorite(target: FavoriteTarget, value: FavoriteExtra | null, omit?: boolean): Promise<void> {
  const ctx = getContext();
  if (!favoriteTargetCurrent(target) || !ctx?.saveChat) throw new Error('聊天或楼层已变化,请重新打开收藏编辑');
  if (favoriteSaving.value) throw new Error('正在保存收藏,请稍候');
  const previous = readFavorite(target.message);
  const previousOmit = !!target.message.extra?.bbs_omit;
  const changesOmit = omit !== undefined && omit !== previousOmit;
  if (changesOmit && engineState.running) throw new Error('摘要正在生成,请稍后修改番外标签');

  favoriteSaving.value = true;
  try {
    writeFavorite(target.message, value);
    revision.value++;
    if (changesOmit) await setFloorOmit(target.floor, omit!);
    if (!favoriteTargetCurrent(target)) throw new Error('聊天或楼层已变化,请重新打开收藏编辑');
    await ctx.saveChat();
  } catch (error) {
    writeFavorite(target.message, previous);
    if (changesOmit) {
      if (favoriteTargetCurrent(target)) {
        try {
          await setFloorOmit(target.floor, previousOmit);
        } catch {
          // 标记已同步回去,保留最初的保存错误供用户重试。
        }
      } else if (previousOmit) {
        (target.message.extra ??= {}).bbs_omit = true;
      } else if (target.message.extra) {
        delete target.message.extra.bbs_omit;
      }
    }
    throw error;
  } finally {
    favoriteSaving.value = false;
    revision.value++;
    recomputeDerived();
  }
}

export async function saveFavorite(target: FavoriteTarget, draft: FavoriteDraft): Promise<void> {
  const title = draft.title.trim();
  const tags = normalizeTags(draft.tags);
  await persistFavorite(target, { ...(title ? { title } : {}), tags: tags.filter(tag => tag !== EXTRA_TAG) }, tags.includes(EXTRA_TAG));
}

export async function removeFavorite(target: FavoriteTarget): Promise<void> {
  // 取消收藏不恢复记忆,只有明确移除番外标签才会改变 bbs_omit。
  await persistFavorite(target, null);
}
