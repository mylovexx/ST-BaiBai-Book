import type { STMessage } from '@/st/context';
import type { ViewNode } from './select';
import type { LeafExtra, SummaryKeyEventTime, SummaryKeyFact, SummaryKeyFactsExtra, SummaryKeyFactView } from './types';

let factSeq = 0;

export function makeKeyFactId(): string {
  factSeq++;
  return `fact_${Date.now().toString(36)}_${factSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 仅检查空白与结构,有效正文不 trim,保留用户保存的每个字符。 */
export function cleanKeyFacts(raw: unknown): SummaryKeyFact[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const facts: SummaryKeyFact[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const { id, text, sourceTime } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || seen.has(id) || typeof text !== 'string' || !text.trim()) continue;
    seen.add(id);
    const fact: SummaryKeyFact = { id, text };
    if (sourceTime && typeof sourceTime === 'object' && !Array.isArray(sourceTime)) {
      const time = sourceTime as Record<string, unknown>;
      fact.sourceTime = {};
      for (const field of ['timeStart', 'timeEnd', 'timeLabel'] as const) {
        if (typeof time[field] === 'string') fact.sourceTime[field] = time[field];
      }
    }
    facts.push(fact);
  }
  return facts;
}

/** ST 会复制旧页 extra 到新页,必须校验事件自己的页码,避免串页。 */
export function getKeyFactSource(message: STMessage | undefined): SummaryKeyFactsExtra | undefined {
  const raw = message?.extra?.bbs_key_facts;
  if (!raw || typeof raw.leafId !== 'string' || !raw.leafId || raw.swipe !== (message?.swipe_id ?? 0)) return;
  const facts = cleanKeyFacts(raw.facts);
  if (!facts.length) return;
  return {
    leafId: raw.leafId,
    swipe: raw.swipe,
    facts,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    timeStart: typeof raw.timeStart === 'string' ? raw.timeStart : undefined,
    timeEnd: typeof raw.timeEnd === 'string' ? raw.timeEnd : undefined,
    timeLabel: typeof raw.timeLabel === 'string' ? raw.timeLabel : undefined,
  };
}

export function getMessageKeyFacts(message: STMessage | undefined): SummaryKeyFact[] {
  return getKeyFactSource(message)?.facts ?? [];
}

export function keyFactViews(
  facts: SummaryKeyFact[], sourceId: string, sourceFloor: number, sourceTime: SummaryKeyEventTime = {},
): SummaryKeyFactView[] {
  return facts.map(fact => {
    const time = fact.sourceTime ?? sourceTime;
    // 来源可能是完整叶子,只取时间字段,避免覆盖事件自己的 id 与原文。
    return {
      ...fact, sourceId, sourceFloor,
      timeStart: time.timeStart, timeEnd: time.timeEnd, timeLabel: time.timeLabel,
    };
  });
}

/** 摘要不存在时只允许维护已有事件,添加入口仍限定在有效摘要上。 */
export function writeMessageKeyFacts(message: STMessage, raw: SummaryKeyFact[], leaf?: LeafExtra): boolean {
  const previous = getKeyFactSource(message);
  const previousTimes = new Map(previous?.facts.map(fact => [fact.id, fact.sourceTime]));
  const facts = cleanKeyFacts(raw).map(fact => {
    const sourceTime = fact.sourceTime ?? previousTimes.get(fact.id);
    return sourceTime ? { ...fact, sourceTime } : fact;
  });
  const currentLeaf = leaf && (leaf.swipe ?? 0) === (message.swipe_id ?? 0) ? leaf : undefined;
  if (!currentLeaf && !previous) return false;
  if (!currentLeaf && facts.some(fact => !previous?.facts.some(old => old.id === fact.id))) return false;
  const leafId = currentLeaf?.id ?? previous!.leafId;
  if (!facts.length) {
    const sources = new Set([leafId, previous?.leafId]);
    if (message.extra) delete message.extra.bbs_key_facts;
    for (const info of message.swipe_info ?? []) {
      if (info?.extra?.bbs_key_facts && sources.has(info.extra.bbs_key_facts.leafId)) delete info.extra.bbs_key_facts;
    }
    return true;
  }
  const record: SummaryKeyFactsExtra = {
    leafId,
    swipe: message.swipe_id ?? 0,
    facts,
    createdAt: currentLeaf?.createdAt ?? previous!.createdAt,
    timeStart: currentLeaf ? currentLeaf.timeStart : previous?.timeStart,
    timeEnd: currentLeaf ? currentLeaf.timeEnd : previous?.timeEnd,
    timeLabel: currentLeaf ? currentLeaf.timeLabel : previous?.timeLabel,
  };
  message.extra = { ...(message.extra ?? {}), bbs_key_facts: record };
  if (message.swipe_info) {
    const info = message.swipe_info[record.swipe] ??= {};
    info.extra = { ...(info.extra ?? {}), bbs_key_facts: record };
  }
  return true;
}

/** 只刷新事件的来源信息,模型生成的正文不会覆盖事件列表。 */
export function syncKeyFactSource(message: STMessage, leaf: LeafExtra): void {
  const source = getKeyFactSource(message);
  if (source) writeMessageKeyFacts(message, source.facts, leaf);
}

/** 同步当前页备份,避免翻回该页时恢复编辑前的摘要。 */
export function syncLeafSwipe(message: STMessage): void {
  const leaf = message.extra?.bbs_leaf;
  const swipe = message.swipe_id ?? 0;
  if (!leaf || (leaf.swipe ?? 0) !== swipe || !message.swipe_info) return;
  const info = message.swipe_info[swipe] ??= {};
  info.extra = { ...(info.extra ?? {}), bbs_leaf: leaf };
}

/** 删除叙事摘要时保留独立事件,同时移除同一摘要的旧页备份。 */
export function removeMessageLeaf(message: STMessage, ids?: Set<string>): boolean {
  const leaf = message.extra?.bbs_leaf;
  const targets = ids ?? new Set(leaf ? [leaf.id] : []);
  let removed = false;
  if (leaf && targets.has(leaf.id)) {
    delete message.extra!.bbs_leaf;
    removed = true;
  }
  for (const info of message.swipe_info ?? []) {
    if (info?.extra?.bbs_leaf && targets.has(info.extra.bbs_leaf.id)) {
      delete info.extra.bbs_leaf;
      removed = true;
    }
  }
  return removed;
}

/** 只生成视图缓存;总结的事件及其时间始终来自叶子,不会产生持久化副本。 */
export function inheritKeyFacts(byId: Map<string, ViewNode>): void {
  const memo = new Map<string, SummaryKeyFactView[]>();
  const visiting = new Set<string>();
  const collect = (node: ViewNode): SummaryKeyFactView[] => {
    if (node.kind === 'leaf') return node.keyFacts ?? [];
    const cached = memo.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id) || node.atomic) return [];
    visiting.add(node.id);
    const facts: SummaryKeyFactView[] = [];
    const seen = new Set<string>();
    for (const id of node.childIds) {
      const child = byId.get(id);
      if (!child) continue;
      for (const fact of collect(child)) {
        if (seen.has(fact.id)) continue;
        seen.add(fact.id);
        facts.push(fact);
      }
    }
    visiting.delete(node.id);
    facts.sort((a, b) => a.sourceFloor - b.sourceFloor);
    memo.set(node.id, facts);
    return facts;
  };
  for (const node of byId.values()) {
    if (node.kind === 'comp') node.keyFacts = collect(node);
  }
}
