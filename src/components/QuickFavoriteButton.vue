<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import { captureFavoriteTarget, favoriteSaving, favorites, isFavorite, removeFavorite, saveFavorite } from '@/favorites/store';
import { toast } from '@/st/toast';

const props = defineProps<{ floor: number; disabled?: boolean }>();
const active = computed(() => favorites.value.some(row => row.floor === props.floor));
const disabled = computed(() => props.disabled || favoriteSaving.value);
const title = computed(() => active.value ? `取消收藏楼层 #${props.floor}` : `收藏楼层 #${props.floor}`);

async function toggle() {
  if (disabled.value) return;
  const target = captureFavoriteTarget(props.floor);
  if (!target) { toast('来源楼层已变化,请重新选择', 'warning'); return; }
  const removing = isFavorite(target.message);
  try {
    if (removing) await removeFavorite(target);
    else await saveFavorite(target, { title: '', tags: [] });
    toast(`${removing ? '已取消收藏' : '已收藏'}楼层 #${target.floor}`, 'success');
  } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error'); }
}
</script>

<template>
  <button type="button" class="bbs-summary-act bbs-quick-favorite" :class="{ 'is-active': active }"
    :disabled="disabled" :title="title" :aria-label="title" :aria-pressed="active"
    @click.stop="toggle" @keydown.enter.stop @keydown.space.stop>
    <Icon name="favorites" />
  </button>
</template>

<style scoped>
.bbs-quick-favorite.is-active { color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-quick-favorite:disabled { cursor: default; opacity: 0.5; }
.bbs-quick-favorite:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
</style>
