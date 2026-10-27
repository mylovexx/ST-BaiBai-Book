<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import { captureFavoriteTarget, favoriteTargetCurrent } from '@/favorites/store';
import { getLeaf, leafValid } from '@/memory/apply';
import { engineState } from '@/memory/engine';
import { forcedRecallRunning, forcedRecallSaving, forcedRecallSelection, selectForcedRecall, type ForcedRecallMode } from '@/memory/forcedRecall';
import { derivedMeta } from '@/memory/store';
import { cleanBody } from '@/memory/timeTag';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';

const props = defineProps<{ floor: number; disabled?: boolean; toggleOnly?: boolean }>();
const busy = computed(() => props.disabled || forcedRecallSaving.value || forcedRecallRunning.value || engineState.running);
const mode = computed(() => {
  void derivedMeta.rev;
  const id = getContext()?.chat?.[props.floor]?.extra?.bbs_force_id;
  return forcedRecallSelection.value.entries.find(entry => entry.messageId === id)?.mode;
});
const reasons = computed(() => {
  void derivedMeta.rev;
  const target = captureFavoriteTarget(props.floor);
  const message = target?.message;
  const common = !target ? '来源楼层已变化'
    : message?.extra?.bbs_omit ? '番外不参与强制注入,请先移除番外标签' : '';
  const leaf = getLeaf(message);
  return {
    summary: common || (!leaf ? '该楼层暂无摘要' : !leafValid(message) ? '当前翻页暂无有效摘要'
      : typeof leaf.text !== 'string' || !leaf.text.trim() ? '该楼层摘要正文为空' : ''),
    full: common || (!cleanBody(message?.mes ?? '').trim() ? '该楼层清洗后正文为空' : ''),
  };
});
const nextMode = computed<ForcedRecallMode | null>(() => {
  // 待生成列表另有取消键,切换模式不能清空该楼选择。
  if (props.toggleOnly) return mode.value === 'summary' ? 'full' : 'summary';
  if (mode.value === 'full') return null;
  if (mode.value === 'summary') return reasons.value.full ? null : 'full';
  // 单键循环跳过不可用模式,缺摘要也能选原文,正文失效也能取消。
  return !reasons.value.summary ? 'summary' : !reasons.value.full ? 'full' : null;
});
const unavailableReason = computed(() => {
  const value = nextMode.value;
  if (props.toggleOnly && value) return reasons.value[value];
  return !mode.value && value === null ? reasons.value.summary : '';
});
const unavailable = computed(() => !!unavailableReason.value);
const title = computed(() => {
  const state = mode.value ? `已选${mode.value === 'full' ? '原文' : '摘要'}` : '未选择强制注入';
  const action = unavailable.value ? unavailableReason.value
    : nextMode.value ? `点击注入${nextMode.value === 'full' ? '原文' : '摘要'}` : '点击取消注入';
  return `楼层 #${props.floor} · ${state};${action}`;
});
async function cycle() {
  if (busy.value || unavailable.value) return;
  const target = captureFavoriteTarget(props.floor);
  if (!target || !favoriteTargetCurrent(target)) { toast('来源楼层已变化,请重新选择', 'warning'); return; }
  const value = nextMode.value;
  try {
    await selectForcedRecall(target.floor, value);
    toast(value ? `已选择强制注入${value === 'full' ? '原文' : '摘要'},用于下一次生成` : '已取消该楼层的强制注入', 'success');
  } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
}
</script>

<template>
  <button type="button" class="bbs-summary-act bbs-force-button" :class="{ 'is-forced': mode, 'is-full': mode === 'full' }"
    :disabled="busy || unavailable" :aria-label="title" :aria-pressed="!!mode" :title="title"
    @click.stop="cycle" @keydown.enter.stop @keydown.space.stop>
    <Icon :name="mode === 'full' ? 'copy' : mode === 'summary' ? 'summary' : 'pin'" />
  </button>
</template>

<style scoped>
.bbs-force-button.is-forced { color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-force-button.is-full { color: var(--bbs-accent-ink); background: var(--bbs-accent); }
.bbs-force-button:disabled { cursor: default; opacity: 0.5; }
.bbs-force-button:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
</style>
