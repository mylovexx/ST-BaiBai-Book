<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import FavoriteEditor from '@/components/FavoriteEditor.vue';
import { captureFavoriteTarget, EXTRA_TAG, MILESTONE_TAG, favorites, favoriteBody, favoriteSaving, favoriteTargetCurrent, readFavorite, removeFavorite, type FavoriteTarget, type FavoriteView } from '@/favorites/store';
import { derivedMeta, recomputeDerived } from '@/memory/store';
import { closeBook } from '@/state/ui';
import { getContext, jumpToFloor } from '@/st/context';
import { toast } from '@/st/toast';

type Filter = { kind: 'all' } | { kind: 'untagged' } | { kind: 'tag'; tag: string };
const filter = ref<Filter>({ kind: 'all' });
const editing = shallowRef<FavoriteTarget | null>(null);
const preview = shallowRef<FavoriteTarget | null>(null);
const busy = ref(false);
const actionDisabled = computed(() => busy.value || favoriteSaving.value);
const tagCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const row of favorites.value) for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const priority = (tag: string) => tag === EXTRA_TAG ? 0 : tag === MILESTONE_TAG ? 1 : 2;
  return [...counts].sort(([a], [b]) => priority(a) - priority(b) || a.localeCompare(b, 'zh-CN'));
});
const untaggedCount = computed(() => favorites.value.filter(row => !row.tags.length).length);
watch(tagCounts, counts => {
  const selected = filter.value;
  if (selected.kind === 'tag' && !counts.some(([tag]) => tag === selected.tag)) filter.value = { kind: 'all' };
});
const filtered = computed(() => {
  const selected = filter.value;
  return favorites.value.filter(row => selected.kind === 'all' || (selected.kind === 'untagged' ? !row.tags.length : row.tags.includes(selected.tag)));
});
const previewBody = computed(() => {
  void derivedMeta.rev;
  return preview.value && favoriteTargetCurrent(preview.value) ? favoriteBody(preview.value.message) : '';
});

function summaryHint(row: FavoriteView): string {
  return row.summaryState === 'missing' ? '该楼层暂无摘要'
    : row.summaryState === 'stale' ? '当前翻页暂无有效摘要'
      : row.summaryState === 'empty' ? '该楼层摘要正文为空' : row.summary;
}

function openEdit(floor: number) {
  editing.value = captureFavoriteTarget(floor);
  preview.value = null;
}
function togglePreview(floor: number) {
  preview.value = preview.value?.floor === floor ? null : captureFavoriteTarget(floor);
  editing.value = null;
}
async function remove(floor: number) {
  const target = captureFavoriteTarget(floor);
  if (!target || actionDisabled.value) return;
  busy.value = true;
  try {
    await removeFavorite(target);
    toast(target.message.extra?.bbs_omit ? '已清除收藏标题及普通标签,番外状态保留' : '已取消收藏', 'success');
    editing.value = null;
    preview.value = null;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  } finally { busy.value = false; }
}
async function jump(floor: number) {
  if (actionDisabled.value) return;
  busy.value = true;
  try {
    if (await jumpToFloor(floor)) closeBook();
    else toast('无法定位该楼层,请确认楼层仍存在且宿主支持历史楼层跳转', 'warning');
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  } finally { busy.value = false; }
}
function resetView() {
  filter.value = { kind: 'all' };
  editing.value = null;
  preview.value = null;
}
watch(() => derivedMeta.rev, () => {
  if (editing.value && !favoriteTargetCurrent(editing.value)) editing.value = null;
  if (preview.value && !favoriteTargetCurrent(preview.value)) preview.value = null;
});
const unbind: Array<() => void> = [];
onMounted(() => {
  recomputeDerived();
  const ctx = getContext();
  const event = ctx?.eventTypes?.CHAT_CHANGED;
  if (event) {
    ctx!.eventSource.on(event, resetView);
    unbind.push(() => ctx!.eventSource.off?.(event, resetView));
  }
  const updatedEvent = ctx?.eventTypes?.MESSAGE_UPDATED;
  if (updatedEvent) {
    ctx!.eventSource.on(updatedEvent, recomputeDerived);
    unbind.push(() => ctx!.eventSource.off?.(updatedEvent, recomputeDerived));
  }
});
onUnmounted(() => unbind.forEach(off => off()));
</script>

<template>
  <section class="bbs-page bbs-favorites-page">
    <header class="bbs-favorites-title">
      <h2 class="bbs-title bbs-title-sub">收藏</h2>
      <span class="bbs-favorites-count">当前聊天 · {{ favorites.length }} 个楼层</span>
    </header>
    <nav class="bbs-favorites-filters" aria-label="按收藏标签筛选">
      <button class="bbs-btn" :class="{ 'is-selected': filter.kind === 'all' }" type="button" :aria-pressed="filter.kind === 'all'" @click="filter = { kind: 'all' }">全部 {{ favorites.length }}</button>
      <button class="bbs-btn" :class="{ 'is-selected': filter.kind === 'untagged' }" type="button" :aria-pressed="filter.kind === 'untagged'" @click="filter = { kind: 'untagged' }">未分类 {{ untaggedCount }}</button>
      <button v-for="[tag, count] in tagCounts" :key="tag" class="bbs-btn" :class="{ 'is-selected': filter.kind === 'tag' && filter.tag === tag }" type="button" :aria-pressed="filter.kind === 'tag' && filter.tag === tag" @click="filter = { kind: 'tag', tag }">{{ tag }} {{ count }}</button>
    </nav>
    <div v-if="filtered.length" class="bbs-favorites-list">
      <article v-for="row in filtered" :key="row.floor" class="bbs-summary-card bbs-favorite-card">
        <header class="bbs-favorite-head">
          <span class="bbs-summary-loc">#{{ row.floor }}</span>
          <h3 class="bbs-favorite-title">{{ row.title }}</h3>
        </header>
        <div class="bbs-favorite-tags">
          <span v-for="tag in row.tags" :key="tag" class="bbs-favorite-tag">{{ tag }}</span>
          <span v-if="!row.tags.length" class="bbs-favorite-tag">未分类</span>
        </div>
        <p class="bbs-favorite-excerpt" :class="{ 'is-muted': row.summaryState !== 'ready' }">{{ summaryHint(row) }}</p>
        <div class="bbs-favorite-actions">
          <button class="bbs-btn" type="button" :disabled="actionDisabled" @click="openEdit(row.floor)"><Icon name="edit" />编辑</button>
          <button class="bbs-btn" type="button" :disabled="actionDisabled" :aria-expanded="preview?.floor === row.floor" @click="togglePreview(row.floor)"><Icon name="eye" />{{ preview?.floor === row.floor ? '收起' : '预览' }}</button>
          <button class="bbs-btn" type="button" :disabled="actionDisabled" @click="jump(row.floor)"><Icon name="navigate" />跳转</button>
          <button class="bbs-btn" type="button" :disabled="actionDisabled || editing !== null || !!(row.message.extra?.bbs_omit && !readFavorite(row.message))" :title="row.message.extra?.bbs_omit ? '取消收藏保留番外状态;移除番外标签请点编辑' : '取消收藏'" @click="remove(row.floor)">取消收藏</button>
        </div>
        <FavoriteEditor v-if="editing?.floor === row.floor" :target="editing" @close="editing = null" />
        <div v-if="preview?.floor === row.floor" class="bbs-favorite-preview">
          <p class="bbs-favorite-preview-text">{{ previewBody || '该楼层暂无可预览正文' }}</p>
        </div>
      </article>
    </div>
    <div v-else class="bbs-empty">
      <Icon name="favorites" class="bbs-empty-icon" />
      <p>{{ favorites.length ? '这个分类暂无收藏。' : '当前聊天还没有收藏。开启设置中的「楼层界面」，点击楼层上的收藏按钮即可添加。' }}</p>
    </div>
  </section>
</template>

<style scoped>
.bbs-favorites-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; }
.bbs-favorites-count { font-size: 12px; color: var(--bbs-ink-muted); }
.bbs-favorites-filters { display: flex; flex-wrap: wrap; gap: 7px; margin: 16px 0; }
.bbs-favorites-filters .bbs-btn { padding: 6px 10px; white-space: normal; overflow-wrap: anywhere; }
.bbs-favorites-filters .is-selected { color: var(--bbs-accent); border-color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-favorites-list { display: grid; gap: 12px; }
.bbs-favorite-card { min-width: 0; }
.bbs-favorite-head { display: flex; align-items: baseline; gap: 10px; }
.bbs-favorite-title { min-width: 0; margin: 0; font-size: 15px; font-weight: 600; color: var(--bbs-ink); overflow-wrap: anywhere; }
.bbs-favorite-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.bbs-favorite-tag { padding: 3px 7px; border-radius: var(--bbs-radius-sm); background: var(--bbs-surface-2); color: var(--bbs-ink-soft); font-size: 11px; overflow-wrap: anywhere; }
.bbs-favorite-excerpt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin: 10px 0; color: var(--bbs-ink-soft); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.bbs-favorite-excerpt.is-muted { color: var(--bbs-ink-muted); }
.bbs-favorite-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.bbs-favorite-actions .bbs-btn { padding: 6px 10px; }
.bbs-favorite-preview { margin-top: 12px; padding: 12px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius-sm); background: var(--bbs-surface-2); }
.bbs-favorite-preview-text { margin: 0; max-height: 50vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--bbs-ink); font-size: 13px; line-height: 1.8; }
</style>
