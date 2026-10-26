import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { ApiSettings } from './settings';
import type { STContext } from '@/st/context';

const host = vi.hoisted(() => ({ getContext: vi.fn() }));
vi.mock('@/st/context', () => ({ getContext: host.getContext }));

beforeEach(() => {
  vi.resetModules();
  host.getContext.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: vi.fn() });
});

afterEach(() => {
  host.getContext.mockReturnValue(null);
  vi.unstubAllGlobals();
});

function useSettings(vector: Record<string, unknown>) {
  const stored = { ui: {}, wiPatternsSeeded: true, vector };
  const ctx = { extensionSettings: { baibai_book: stored }, saveSettingsDebounced: vi.fn() };
  host.getContext.mockReturnValue(ctx as unknown as STContext);
  return ctx;
}

describe('traditional vector settings', () => {
  it.each([
    ['missing field', undefined, false], ['null', null, false], ['string', 'true', false],
    ['number', 1, false], ['enabled', true, true], ['disabled', false, false],
  ])('hydrates the option with a boolean default (%s)', async (_label, raw, expected) => {
    useSettings(raw === undefined ? {} : { traditionalMode: raw });
    const { apiSettings, hydrateSettings } = await import('./settings');
    hydrateSettings();
    expect(apiSettings.vector.traditionalMode).toBe(expected);
    await nextTick();
  });

  it('waits for hydration before writing back to the server', async () => {
    const ctx = useSettings({ traditionalMode: true });
    const stored = ctx.extensionSettings.baibai_book;
    const { apiSettings, hydrateSettings } = await import('./settings');
    expect(apiSettings.vector.traditionalMode).toBe(false);
    apiSettings.vector.embedding.model = 'A local default before ST is ready';
    await nextTick();
    expect(ctx.extensionSettings.baibai_book).toBe(stored);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();

    hydrateSettings();
    expect(apiSettings.vector.traditionalMode).toBe(true);
    await nextTick();
    expect((ctx.extensionSettings.baibai_book as unknown as ApiSettings).vector.traditionalMode).toBe(true);
  });

  it('persists the option across reloads while retaining the rewrite configuration', async () => {
    const ctx = useSettings({ traditionalMode: false, queryRewrite: { model: 'saved-rewrite-model', url: 'https://rewrite.example/v1' } });
    const { apiSettings, hydrateSettings } = await import('./settings');
    hydrateSettings();
    await nextTick();
    ctx.saveSettingsDebounced.mockClear();
    apiSettings.vector.traditionalMode = true;
    await nextTick();
    expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    expect((ctx.extensionSettings.baibai_book as unknown as ApiSettings).vector).toMatchObject({
      traditionalMode: true, queryRewrite: { model: 'saved-rewrite-model', url: 'https://rewrite.example/v1' },
    });

    vi.resetModules();
    const reloaded = await import('./settings');
    reloaded.hydrateSettings();
    expect(reloaded.apiSettings.vector.traditionalMode).toBe(true);
    expect(reloaded.apiSettings.vector.queryRewrite.model).toBe('saved-rewrite-model');
    await nextTick();
  });
});
