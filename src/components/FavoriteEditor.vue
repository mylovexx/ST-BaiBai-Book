<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Icon from '@/components/Icon.vue';
import { availableFavoriteTags, EXTRA_TAG, favoriteSaving, favoriteTags, favoriteTargetCurrent, normalizeTags, readFavorite, removeFavorite, saveFavorite, type FavoriteTarget } from '@/favorites/store';
import { engineState } from '@/memory/engine';
import { toast } from '@/st/toast';

const props = defineProps<{ target: FavoriteTarget }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const stored = readFavorite(props.target.message);
const draft = reactive({ title: stored?.title ?? '', tags: favoriteTags(props.target.message) });
const newTag = ref('');
const busy = ref(false);
const error = ref('');
const tags = computed(() => normalizeTags([...availableFavoriteTags.value, ...draft.tags]));
const changesOmit = computed(() => draft.tags.includes(EXTRA_TAG) !== !!props.target.message.extra?.bbs_omit);
const saveDisabled = computed(() => busy.value || favoriteSaving.value || (changesOmit.value && engineState.running));

function toggleTag(tag: string) {
  const index = draft.tags.indexOf(tag);
  if (index < 0) draft.tags.push(tag);
  else draft.tags.splice(index, 1);
}

function addTag() {
  const tag = newTag.value.trim();
  if (tag && !draft.tags.includes(tag)) draft.tags.push(tag);
  newTag.value = '';
}

async function commit(remove = false) {
  if (busy.value || favoriteSaving.value || (!remove && saveDisabled.value)) return;
  if (!favoriteTargetCurrent(props.target)) {
    error.value = '聊天或楼层已变化,请重新打开收藏编辑';
    return;
  }
  if (!remove) addTag();
  busy.value = true;
  error.value = '';
  try {
    if (remove) await removeFavorite(props.target);
    else await saveFavorite(props.target, draft);
    toast(remove ? (props.target.message.extra?.bbs_omit ? '已清除收藏标题及普通标签,番外状态保留' : '已取消收藏') : '收藏已保存', 'success');
    emit('close');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="bbs-favorite-editor" @submit.prevent="commit()" @click.stop @keydown.esc.stop.prevent="!busy && !favoriteSaving && emit('close')">
    <label class="bbs-favorite-field">
      <span>楼层 #{{ target.floor }} · 收藏标题</span>
      <input v-model="draft.title" class="bbs-input" type="text" :disabled="busy || favoriteSaving" :placeholder="`楼层 #${target.floor}`" />
    </label>
    <fieldset :disabled="busy || favoriteSaving" class="bbs-favorite-fieldset">
      <legend>标签（可多选，也可不选）</legend>
      <div class="bbs-favorite-tag-options">
        <button v-for="tag in tags" :key="tag" class="bbs-btn bbs-favorite-tag-option" :class="{ 'is-selected': draft.tags.includes(tag) }" type="button" :aria-pressed="draft.tags.includes(tag)" @click="toggleTag(tag)">
          <Icon v-if="draft.tags.includes(tag)" name="check" :size="12" />{{ tag }}
        </button>
      </div>
      <div class="bbs-favorite-add-tag">
        <input v-model="newTag" class="bbs-input" type="text" placeholder="自定义标签…" aria-label="自定义收藏标签" @keydown.enter.stop.prevent="addTag" />
        <button class="bbs-btn" type="button" :disabled="!newTag.trim()" @click="addTag">添加</button>
      </div>
    </fieldset>
    <p class="bbs-favorite-hint">「番外」不参与摘要、总结和记忆注入；移除该标签才会恢复。取消收藏仍保留番外状态。</p>
    <p v-if="changesOmit && engineState.running" class="bbs-favorite-hint">摘要正在生成，请稍后修改番外标签。</p>
    <p v-if="error" class="bbs-favorite-error" role="alert">{{ error }}</p>
    <footer class="bbs-favorite-editor-actions">
      <button v-if="stored || target.message.extra?.bbs_omit" class="bbs-btn" type="button" :disabled="busy || favoriteSaving" @click="commit(true)">取消收藏</button>
      <span class="bbs-favorite-spacer"></span>
      <button class="bbs-btn" type="button" :disabled="busy || favoriteSaving" @click="emit('close')">关闭</button>
      <button class="bbs-btn bbs-btn-primary" type="submit" :disabled="saveDisabled">{{ busy ? '保存中…' : '保存收藏' }}</button>
    </footer>
  </form>
</template>

<style scoped>
.bbs-favorite-editor {
  display: grid;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-size: 13px;
}
.bbs-favorite-field { display: grid; gap: 6px; }
.bbs-favorite-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.bbs-favorite-fieldset legend { padding: 0; margin-bottom: 8px; }
.bbs-favorite-tag-options { display: flex; flex-wrap: wrap; gap: 6px; }
.bbs-favorite-tag-option { white-space: normal; overflow-wrap: anywhere; padding: 5px 9px; }
.bbs-favorite-tag-option.is-selected { color: var(--bbs-accent); border-color: var(--bbs-accent); background: var(--bbs-accent-soft); }
.bbs-favorite-add-tag { display: flex; gap: 8px; margin-top: 8px; }
.bbs-favorite-add-tag .bbs-input { flex: 1; min-width: 0; }
.bbs-favorite-hint { margin: 0; color: var(--bbs-ink-muted); line-height: 1.6; }
.bbs-favorite-error { margin: 0; color: var(--bbs-danger); }
.bbs-favorite-editor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bbs-favorite-spacer { flex: 1; }
@media (max-width: 640px) {
  .bbs-favorite-editor-actions .bbs-btn { padding: 7px 10px; }
}
</style>
