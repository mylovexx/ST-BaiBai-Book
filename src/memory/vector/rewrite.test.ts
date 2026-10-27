import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '../engine';
import { memory } from '../store';
import { createEmptyMemory } from '../types';
import { rewriteQuery } from './rewrite';

const originalVector = JSON.parse(JSON.stringify(apiSettings.vector));
const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' };
const key = 'sk-test:a#b "quoted"';
const fetchMock = vi.fn<typeof fetch>();
const chat: STMessage[] = [
  { name: '艾琳', is_user: false, is_system: false, mes: '艾琳提起了当年的约定。' },
  { name: '林舟', is_user: true, is_system: false, mes: '她还记得当年的约定吗？' },
];

beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.vector = JSON.parse(JSON.stringify(originalVector));
  Object.assign(apiSettings.vector.queryRewrite, {
    url: 'https://rewrite.example/v1', key, model: 'rewrite-model', timeoutSec: 10, retries: 2,
  });
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat, chatMetadata: {}, name1: '林舟', name2: '艾琳', getRequestHeaders: () => headers,
  } as unknown as STContext);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(0);
  fetchMock.mockReset().mockImplementation(async () => Response.json({
    choices: [{ message: { content: 'INTENT: 回忆当年的约定。\nQ1: 曾经的约定\nQ2: 艾琳与林舟的往事' } }],
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  apiSettings.vector = JSON.parse(JSON.stringify(originalVector));
  Object.assign(memory, createEmptyMemory());
});

describe('Query 重写:ST 服务端转发', () => {
  it.each([
    'https://rewrite.example/v1/',
    'https://rewrite.example/v1/embeddings/',
    'https://rewrite.example/v1/chat/completions/',
  ])('地址 %s 经宿主转发并解析查询', async url => {
    apiSettings.vector.queryRewrite.url = url;

    expect(await rewriteQuery()).toEqual({
      intent: '回忆当年的约定。', queries: ['曾经的约定', '艾琳与林舟的往事'],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('/api/backends/chat-completions/generate');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(headers);
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      chat_completion_source: 'custom', custom_url: 'https://rewrite.example/v1',
      model: 'rewrite-model', tool_choice: 'none', stream: false,
    });
    // ST custom 源靠 JSON 字符串注入上游参数,密钥不能混入宿主请求头。
    expect(JSON.parse(body.custom_include_headers)).toEqual({ Authorization: `Bearer ${key}` });
    expect(JSON.parse(body.custom_include_body)).toEqual({ enable_thinking: false });
    expect(body.messages).toContainEqual({ role: 'user', content: chat[1].mes });
  });

  it('重写地址与密钥留空时复用 embedding 渠道,保留重写模型', async () => {
    Object.assign(apiSettings.vector.queryRewrite, { url: '', key: '' });
    Object.assign(apiSettings.vector.embedding, {
      url: 'https://embedding.example/v1/embeddings', key: 'embedding-key', model: 'embedding-model',
    });

    await rewriteQuery();

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.custom_url).toBe('https://embedding.example/v1');
    expect(body.model).toBe('rewrite-model');
    expect(JSON.parse(body.custom_include_headers)).toEqual({ Authorization: 'Bearer embedding-key' });
  });

  it.each([
    [{ message: '上游额度耗尽' }, '上游额度耗尽'],
    [{}, '未知错误'],
  ])('HTTP 200 内含错误时抛错,不解析为成功或重复请求', async (error, message) => {
    fetchMock.mockImplementation(async () => Response.json({ error }));

    await expect(rewriteQuery()).rejects.toThrow(`Query 重写 API 错误:${message}`);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
