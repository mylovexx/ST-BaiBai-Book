import { computed, ref } from 'vue';
import { getContext, type STContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { getLeaf, leafValid } from './apply';
import { isRealAiReply } from './engine';
import { derivedMeta } from './store';
import { cleanBody, formatRange, parseTimeRange } from './timeTag';

export type ForcedRecallMode = 'summary' | 'full';
export interface ForcedRecallEntry { messageId: string; mode: ForcedRecallMode }
export interface ForcedRecallRound { roundId: string; entries: ForcedRecallEntry[] }
export interface ForcedRecallHistory extends ForcedRecallRound { at: number }
export interface ForcedRecallState {
  version: 1;
  // null 表示没有新选择,[] 表示明确清空,不能混为一谈。
  pending: ForcedRecallEntry[] | null;
  history: ForcedRecallHistory[];
}
export interface ForcedRecallItem extends ForcedRecallEntry {
  floor: number;
  body: string;
  storyTime: string;
  leafId?: string;
  reason: string;
}

export const FORCED_RECALL_KEY = 'baibai_book_forced_recall';
export const FORCED_RECALL_HISTORY_LIMIT = 10;
export const forcedRecallSaving = ref(false);
export const forcedRecallRunning = ref(false);
const revision = ref(0);
let pendingSave: Promise<void> | null = null;

function normalizeEntries(raw: unknown): ForcedRecallEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries = new Map<string, ForcedRecallEntry>();
  for (const entry of raw) {
    if (entry && typeof entry.messageId === 'string' && entry.messageId
      && (entry.mode === 'summary' || entry.mode === 'full')) {
      entries.set(entry.messageId, { messageId: entry.messageId, mode: entry.mode });
    }
  }
  return [...entries.values()];
}

export function readForcedRecallState(ctx = getContext()): ForcedRecallState {
  const raw = ctx?.chatMetadata?.[FORCED_RECALL_KEY] as Partial<ForcedRecallState> | undefined;
  const history = Array.isArray(raw?.history) ? raw.history.filter(row => row && typeof row.roundId === 'string'
    && Number.isFinite(row.at)).map(row => ({ roundId: row.roundId, at: row.at, entries: normalizeEntries(row.entries) })) : [];
  const seen = new Set<string>();
  return {
    version: 1,
    pending: Array.isArray(raw?.pending) ? normalizeEntries(raw.pending) : null,
    history: history.sort((a, b) => b.at - a.at).filter(row => {
      if (seen.has(row.roundId)) return false;
      seen.add(row.roundId);
      return true;
    }).slice(0, FORCED_RECALL_HISTORY_LIMIT),
  };
}

export function latestForcedRecallUser(chat: STMessage[]): STMessage | undefined {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].is_user && !chat[i].is_system) return chat[i];
  }
  return undefined;
}

function readRound(message: STMessage | undefined): ForcedRecallRound | null {
  const raw = message?.extra?.bbs_forced_recall;
  return raw && typeof raw.roundId === 'string'
    ? { roundId: raw.roundId, entries: normalizeEntries(raw.entries) } : null;
}

export const forcedRecallSelection = computed(() => {
  void revision.value;
  void derivedMeta.rev;
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) return { pending: false, entries: [] as ForcedRecallEntry[] };
  const state = readForcedRecallState(ctx);
  return { pending: state.pending !== null,
    entries: state.pending ?? readRound(latestForcedRecallUser(ctx.chat))?.entries ?? [] };
});
export const forcedRecallHistory = computed(() => {
  void revision.value;
  void derivedMeta.rev;
  const ctx = getContext();
  return ctx?.getCurrentChatId?.() ? readForcedRecallState(ctx).history : [];
});

export function resolveForcedMessage(messageId: string, chat = getContext()?.chat ?? []): STMessage | undefined {
  const matches = chat.filter(message => message.extra?.bbs_force_id === messageId);
  // 导入或复制消息可能携带重复 id;宁可提示失效,也不要注入另一楼。
  return matches.length === 1 ? matches[0] : undefined;
}

export function inspectForcedRecall(entry: ForcedRecallEntry, chat = getContext()?.chat ?? [], beforeFloor = chat.length): ForcedRecallItem {
  const message = resolveForcedMessage(entry.messageId, chat);
  const floor = message ? chat.indexOf(message) : -1;
  const leaf = getLeaf(message);
  let reason = !message ? '来源楼层已删除或无法唯一定位'
    : !isRealAiReply(message) ? '来源不是剧情楼层'
      : message.extra?.bbs_omit ? '番外不参与强制注入'
        : floor >= beforeFloor ? '来源楼层正在重生成或位于本轮之后' : '';
  let body = '';
  if (!reason && entry.mode === 'summary') {
    reason = !leaf ? '该楼层暂无摘要' : !leafValid(message) ? '当前翻页暂无有效摘要' : '';
    body = reason || typeof leaf?.text !== 'string' ? '' : leaf.text.trim();
    if (!reason && !body) reason = '该楼层摘要正文为空';
  } else if (!reason && message) {
    body = cleanBody(message.mes).trim();
    if (!body) reason = '该楼层清洗后正文为空';
  }
  const time = message ? parseTimeRange(message.mes) : {};
  const storyTime = formatRange(time.start || leaf?.timeStart, time.end || leaf?.timeEnd) || leaf?.timeLabel || '';
  return { ...entry, floor, body, storyTime, leafId: leaf?.id, reason };
}

function currentContext(): STContext {
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.() || !ctx.chatMetadata || !ctx.saveChat || !ctx.saveMetadata) {
    throw new Error('聊天尚未就绪或宿主不支持保存');
  }
  return ctx;
}

function ensureMessageId(message: STMessage): string {
  const id = message.extra?.bbs_force_id || `force_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  // 标记属于物理楼层,不随 swipe 的摘要与正文变化。
  for (const extra of [message.extra ??= {}, ...(message.swipe_info ?? []).flatMap(info => info ? [info.extra ??= {}] : [])]) {
    extra.bbs_force_id = id;
  }
  return id;
}

async function persistChange(ctx: STContext, mutate: (state: ForcedRecallState) => void): Promise<void> {
  if (forcedRecallSaving.value) throw new Error('强制注入正在保存,请稍候');
  const chatId = ctx.getCurrentChatId();
  const chat = ctx.chat;
  const metadata = ctx.chatMetadata;
  const previousState = metadata[FORCED_RECALL_KEY];
  const backups = chat.flatMap(message => [message, ...(message.swipe_info ?? []).filter(info => !!info)])
    .map(holder => ({ holder, hadExtra: !!holder.extra, id: holder.extra?.bbs_force_id, round: holder.extra?.bbs_forced_recall }));
  const current = () => getContext()?.getCurrentChatId?.() === chatId && getContext()?.chat === chat
    && getContext()?.chatMetadata === metadata;
  forcedRecallSaving.value = true;
  const task = (async () => {
    try {
      const state = readForcedRecallState(ctx);
      mutate(state);
      metadata[FORCED_RECALL_KEY] = state;
      revision.value++;
      await ctx.saveChat();
      if (!current()) throw new Error('聊天已变化,请重新选择强制注入');
      await ctx.saveMetadata();
      if (!current()) throw new Error('聊天已变化,请重新选择强制注入');
    } catch (error) {
      if (previousState === undefined) delete metadata[FORCED_RECALL_KEY];
      else metadata[FORCED_RECALL_KEY] = previousState;
      for (const { holder, hadExtra, id, round } of backups) {
        const extra = holder.extra;
        if (!extra) continue;
        if (id === undefined) delete extra.bbs_force_id; else extra.bbs_force_id = id;
        if (round === undefined) delete extra.bbs_forced_recall; else extra.bbs_forced_recall = round;
        if (!hadExtra && !Object.keys(extra).length) delete holder.extra;
      }
      throw error;
    } finally {
      forcedRecallSaving.value = false;
      revision.value++;
    }
  })();
  pendingSave = task;
  try { await task; } finally { if (pendingSave === task) pendingSave = null; }
}

function assertEditable(): void {
  if (forcedRecallRunning.value) throw new Error('本轮生成准备中,请稍后调整强制注入');
}

export async function selectForcedRecall(floor: number, mode: ForcedRecallMode | null): Promise<void> {
  assertEditable();
  const ctx = currentContext();
  const message = ctx.chat[floor];
  if (!Number.isInteger(floor) || !isRealAiReply(message)) throw new Error('来源楼层已变化,请重新选择');
  if (mode && message.extra?.bbs_omit) throw new Error('番外不参与强制注入,请先移除番外标签');
  await persistChange(ctx, state => {
    const id = ensureMessageId(message);
    if (mode) {
      const item = inspectForcedRecall({ messageId: id, mode }, ctx.chat);
      if (item.reason) throw new Error(item.reason);
    }
    const base = state.pending ?? readRound(latestForcedRecallUser(ctx.chat))?.entries ?? [];
    state.pending = base.filter(entry => entry.messageId !== id);
    if (mode) state.pending.push({ messageId: id, mode });
  });
}

export async function removeForcedRecall(messageId?: string): Promise<void> {
  assertEditable();
  const ctx = currentContext();
  await persistChange(ctx, state => {
    const base = state.pending ?? readRound(latestForcedRecallUser(ctx.chat))?.entries ?? [];
    state.pending = messageId ? base.filter(entry => entry.messageId !== messageId) : [];
  });
}

export async function reuseForcedRecall(entries: ForcedRecallEntry[]): Promise<number> {
  assertEditable();
  const ctx = currentContext();
  let skipped = 0;
  await persistChange(ctx, state => {
    const base = state.pending ?? readRound(latestForcedRecallUser(ctx.chat))?.entries ?? [];
    const merged = new Map(base.map(entry => [entry.messageId, entry]));
    for (const entry of normalizeEntries(entries)) {
      if (inspectForcedRecall(entry, ctx.chat).reason) { skipped++; continue; }
      merged.set(entry.messageId, entry);
    }
    state.pending = [...merged.values()];
  });
  return skipped;
}

/** 放行生成后才绑定草稿;失败的主回复也可在同轮继续重试。 */
export async function prepareForcedRecallRound(): Promise<ForcedRecallRound | null> {
  if (pendingSave) await pendingSave;
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) return null;
  const user = latestForcedRecallUser(ctx.chat);
  const state = readForcedRecallState(ctx);
  const saved = readRound(user);
  if (state.pending === null && !saved?.entries.length) return saved;
  if (!user) {
    toast('强制注入尚无可绑定的用户楼层,选择会保留到下一次生成', 'warning');
    return null;
  }
  let round: ForcedRecallRound | null = null;
  await persistChange(currentContext(), next => {
    round = { roundId: ensureMessageId(user), entries: next.pending ?? saved?.entries ?? [] };
    (user.extra ??= {}).bbs_forced_recall = round;
    next.pending = null;
    const previous = next.history.find(row => row.roundId === round!.roundId);
    if (round.entries.length || previous) {
      const history = [{ ...round, at: Date.now() }, ...next.history.filter(row => row.roundId !== round!.roundId)];
      next.history = history.slice(0, FORCED_RECALL_HISTORY_LIMIT);
      const evicted = new Set(history.slice(FORCED_RECALL_HISTORY_LIMIT).map(row => row.roundId));
      // 历史截断时同步清理消息上的组合,避免界面只有十条而聊天文件无限累积。
      for (const message of ctx.chat) {
        if (message.extra?.bbs_forced_recall && evicted.has(message.extra.bbs_forced_recall.roundId)) {
          delete message.extra.bbs_forced_recall;
        }
      }
    }
  });
  return round;
}

export function forcedRecallRoundCurrent(round: ForcedRecallRound | null, ctx: STContext): boolean {
  if (!round) return readForcedRecallState(ctx).pending === null;
  const user = latestForcedRecallUser(ctx.chat);
  return user?.extra?.bbs_force_id === round.roundId;
}
