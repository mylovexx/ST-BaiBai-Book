<script setup lang="ts">
import { computed, ref } from 'vue';
import Collapsible from './Collapsible.vue';
import ForcedRecallButton from './ForcedRecallButton.vue';
import { readFavorite } from '@/favorites/store';
import { engineState } from '@/memory/engine';
import { forcedRecallHistory, forcedRecallRunning, forcedRecallSaving, forcedRecallSelection, inspectForcedRecall,
  removeForcedRecall, resolveForcedMessage, reuseForcedRecall, type ForcedRecallEntry } from '@/memory/forcedRecall';
import { derivedMeta } from '@/memory/store';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';

const busy = ref(false);
const disabled = computed(() => busy.value || forcedRecallRunning.value || forcedRecallSaving.value || engineState.running);
function describe(entry: ForcedRecallEntry) {
  void derivedMeta.rev;
  const item = inspectForcedRecall(entry);
  const summary = entry.mode === 'summary' ? item : inspectForcedRecall({ ...entry, mode: 'summary' });
  const message = resolveForcedMessage(entry.messageId);
  return { ...item, summary: summary.body, summaryReason: summary.reason,
    title: readFavorite(message)?.title || (item.floor >= 0 ? `楼层 #${item.floor}` : '已删除的楼层') };
}
const selection = computed(() => forcedRecallSelection.value.entries.map(describe));
const histories = computed(() => {
  void derivedMeta.rev;
  return forcedRecallHistory.value.map(row => ({ ...row,
    floor: getContext()?.chat.indexOf(resolveForcedMessage(row.roundId)!) ?? -1,
    items: row.entries.map(describe),
  }));
});
async function act(action: () => Promise<unknown>) {
  if (disabled.value) return;
  busy.value = true;
  try { await action(); } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
  finally { busy.value = false; }
}
async function reuse(entries: ForcedRecallEntry[]) {
  await act(async () => {
    const skipped = await reuseForcedRecall(entries);
    toast(skipped ? `已合并有效选择,跳过 ${skipped} 个失效或番外项目` : '已合并选择,用于下一次生成', skipped ? 'warning' : 'success');
  });
}
const modeLabel = (mode: string) => mode === 'full' ? '原文' : '摘要';
const timeLabel = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
</script>

<template>
  <div class="bbs-force-history">
    <Collapsible :title="`${forcedRecallSelection.pending ? '待生成选择' : '当前轮强制注入'} · ${selection.length} 条`" :open="true">
      <p class="bbs-field-hint">新选择在下一次生成时绑定该轮,重 roll、翻页保留,下一轮不自动沿用。不占向量召回名额。</p>
      <div v-for="item in selection" :key="item.messageId" class="bbs-force-row">
        <div class="bbs-force-row-head">
          <span v-if="item.floor >= 0" class="bbs-summary-loc">#{{ item.floor }}</span>
          <span>{{ item.title }} · {{ modeLabel(item.mode) }}</span>
          <span class="bbs-force-row-actions">
            <ForcedRecallButton v-if="item.floor >= 0" :floor="item.floor" :disabled="disabled" toggle-only />
            <button class="bbs-btn" type="button" :disabled="disabled" @click="act(() => removeForcedRecall(item.messageId))">取消</button>
          </span>
        </div>
        <p v-if="item.reason" class="bbs-field-hint">{{ item.reason }}</p>
        <p v-if="item.summary" class="bbs-force-preview">{{ item.summary }}</p>
        <p v-else-if="item.summaryReason && item.summaryReason !== item.reason" class="bbs-field-hint">{{ item.summaryReason }}</p>
      </div>
      <p v-if="!selection.length" class="bbs-field-hint">{{ forcedRecallSelection.pending ? '已选择清空,下一次生成不使用强制注入。' : '当前轮没有强制注入。点击摘要或收藏卡片右侧的注入按钮,依次选择摘要、原文、取消。' }}</p>
      <button v-if="selection.length" class="bbs-btn" type="button" :disabled="disabled" @click="act(() => removeForcedRecall())">清空选择</button>
    </Collapsible>
    <Collapsible :title="`强制注入历史 · 最近 ${histories.length} 次`" :open="false">
      <p class="bbs-field-hint">保留最近 10 个轮次,同轮重 roll 更新原记录。重新选择会读取楼层当前的摘要或原文。</p>
      <article v-for="row in histories" :key="row.roundId" class="bbs-force-history-card">
        <header class="bbs-force-row-head">
          <span>{{ row.floor >= 0 ? `用户楼 #${row.floor} 对应轮次` : '原轮次已删除' }}</span>
          <span class="bbs-field-hint">{{ timeLabel(row.at) }}</span>
          <button class="bbs-btn" type="button" :disabled="disabled || !row.items.length" @click="reuse(row.entries)">合并整组</button>
        </header>
        <div v-for="item in row.items" :key="item.messageId" class="bbs-force-row">
          <div class="bbs-force-row-head">
            <span>{{ item.title }} · {{ modeLabel(item.mode) }}</span>
            <button class="bbs-btn" type="button" :disabled="disabled || !!item.reason" @click="reuse([item])">重新选择</button>
          </div>
          <p v-if="item.reason" class="bbs-field-hint">{{ item.reason }}</p>
          <p v-if="item.summary" class="bbs-force-preview">{{ item.summary }}</p>
          <p v-else-if="item.summaryReason && item.summaryReason !== item.reason" class="bbs-field-hint">{{ item.summaryReason }}</p>
        </div>
        <p v-if="!row.items.length" class="bbs-field-hint">该轮强制注入已取消。</p>
      </article>
      <p v-if="!histories.length" class="bbs-field-hint">尚无强制注入历史。</p>
    </Collapsible>
  </div>
</template>

<style scoped>
.bbs-force-history { margin: 16px 0; }
.bbs-force-row { margin: 8px 0; }
.bbs-force-row-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.bbs-force-row-head .bbs-btn { padding: 4px 8px; margin-left: auto; }
.bbs-force-row-actions { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.bbs-force-history-card { margin: 10px 0; padding: 12px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius-sm); }
.bbs-force-preview { margin: 6px 0; font-size: 12px; line-height: 1.7; color: var(--bbs-ink-soft); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
