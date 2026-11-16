<script setup lang="ts">
import Icon from './Icon.vue';
import { makeKeyFactId } from '@/memory/keyFacts';
import type { SummaryKeyFact } from '@/memory/types';

const props = withDefaults(defineProps<{ modelValue: SummaryKeyFact[]; allowAdd?: boolean }>(), { allowAdd: true });
const emit = defineEmits<{ 'update:modelValue': [facts: SummaryKeyFact[]] }>();

function updateText(index: number, event: Event) {
  const text = (event.target as HTMLTextAreaElement).value;
  emit('update:modelValue', props.modelValue.map((fact, i) => i === index ? { ...fact, text } : fact));
}
function addFact() {
  emit('update:modelValue', [...props.modelValue, { id: makeKeyFactId(), text: '' }]);
}
function removeFact(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index));
}
</script>

<template>
  <section class="bbs-key-facts-editor">
    <div class="bbs-key-facts-editor-head">
      <span class="bbs-modal-label">关键事实</span>
      <button v-if="allowAdd" class="bbs-btn bbs-btn-sm" type="button" @click="addFact">
        <Icon name="plus" />添加事实
      </button>
    </div>
    <p class="bbs-field-hint">各级总结会原样继承。删除事实仅移除此条事实,摘要正文仍保留。</p>
    <div v-for="(fact, index) in modelValue" :key="fact.id" class="bbs-key-facts-editor-item">
      <label :for="fact.id" class="bbs-key-facts-editor-label">事实 {{ index + 1 }}</label>
      <button class="bbs-summary-act" type="button" :aria-label="`删除事实 ${index + 1}`" title="删除这条事实" @click="removeFact(index)">
        <Icon name="trash" />
      </button>
      <textarea :id="fact.id" :value="fact.text" class="bbs-input" rows="3" placeholder="粘贴或填写需要原样保留的事实,可包含多行" @input="updateText(index, $event)"></textarea>
    </div>
    <p v-if="!modelValue.length" class="bbs-field-hint">暂无关键事实。</p>
  </section>
</template>

<style scoped>
.bbs-key-facts-editor { display: grid; gap: 10px; margin: 12px 0; min-width: 0; }
.bbs-key-facts-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bbs-key-facts-editor-head .bbs-btn { display: inline-flex; align-items: center; gap: 4px; }
.bbs-key-facts-editor .bbs-field-hint { margin: 0; }
.bbs-key-facts-editor-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.bbs-key-facts-editor-label { color: var(--bbs-ink-muted); font-size: 12px; }
.bbs-key-facts-editor-item textarea { grid-column: 1 / -1; width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box; }
</style>
