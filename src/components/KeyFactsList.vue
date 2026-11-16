<script setup lang="ts">
import type { SummaryKeyFactView } from '@/memory/types';

withDefaults(defineProps<{ facts: SummaryKeyFactView[]; showSources?: boolean; query?: string; expanded?: boolean }>(), {
  showSources: false, query: '', expanded: false,
});

/** 分段标亮而非 v-html,事件里的标签与符号仍作为原文显示。 */
function parts(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const match = needle.toLowerCase();
  const result: Array<{ text: string; hit: boolean }> = [];
  let offset = 0;
  while (offset < text.length) {
    const index = lower.indexOf(match, offset);
    if (index < 0) { result.push({ text: text.slice(offset), hit: false }); break; }
    if (index > offset) result.push({ text: text.slice(offset, index), hit: false });
    result.push({ text: text.slice(index, index + needle.length), hit: true });
    offset = index + needle.length;
  }
  return result;
}
</script>

<template>
  <details v-if="facts.length" class="bbs-key-facts-list" :open="expanded || !!query">
    <summary @click.stop>关键事件 {{ facts.length }} 条<span v-if="showSources"> · 继承</span></summary>
    <div v-for="fact in facts" :key="fact.id" class="bbs-key-facts-list-item">
      <span v-if="showSources" class="bbs-key-facts-source">来源楼层 #{{ fact.sourceFloor }}</span>
      <p class="bbs-key-fact-text"><template v-for="(part, index) in parts(fact.text, query)" :key="index"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
    </div>
  </details>
</template>

<style scoped>
.bbs-key-facts-list { margin: 10px 0 4px; padding: 9px 12px; border: 1px solid var(--bbs-line); border-radius: 8px; background: var(--bbs-surface-2); min-width: 0; }
.bbs-key-facts-list summary { cursor: pointer; color: var(--bbs-ink-muted); font-size: 12px; }
.bbs-key-facts-list-item { margin-top: 9px; }
.bbs-key-facts-list-item + .bbs-key-facts-list-item { padding-top: 9px; border-top: 1px solid var(--bbs-line); }
.bbs-key-facts-source { font-size: 11px; color: var(--bbs-ink-muted); }
.bbs-key-fact-text { margin: 3px 0 0; color: var(--bbs-ink); font-size: 13px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.bbs-key-fact-text mark { background: var(--bbs-accent-soft); color: inherit; border-radius: 2px; }
</style>
