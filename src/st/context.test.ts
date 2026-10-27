import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpToFloor, type STContext, type STMessage } from './context';

let ctx: STContext;
let query: ReturnType<typeof vi.fn>;
const message: STMessage = { name: '角色', is_user: false, is_system: true, mes: '正文', extra: { bbs_hidden: true } };

beforeEach(() => {
  ctx = { chat: [message], getCurrentChatId: () => '聊天', executeSlashCommandsWithOptions: vi.fn().mockResolvedValue(undefined) } as unknown as STContext;
  query = vi.fn().mockReturnValue(null);
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  vi.stubGlobal('document', { querySelector: query });
});
afterEach(() => vi.unstubAllGlobals());

describe('收藏楼层跳转', () => {
  it('已渲染消息直接滚动,不修改隐藏标记', async () => {
    const element = { scrollIntoView: vi.fn() };
    query.mockReturnValue(element);
    await expect(jumpToFloor(0)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith('#chat .mes[mesid="0"]');
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(ctx.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
    expect(message.is_system).toBe(true);
    expect(message.extra?.bbs_hidden).toBe(true);
  });

  it('未加载消息使用宿主命令后定位', async () => {
    const element = { scrollIntoView: vi.fn() };
    vi.mocked(ctx.executeSlashCommandsWithOptions!).mockImplementation(async () => { query.mockReturnValue(element); });
    await expect(jumpToFloor(0)).resolves.toBe(true);
    expect(ctx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/chat-jump 0');
    expect(element.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('宿主不支持命令且找不到楼层时返回失败', async () => {
    vi.mocked(ctx.executeSlashCommandsWithOptions!).mockRejectedValue(new Error('不支持'));
    await expect(jumpToFloor(0)).resolves.toBe(false);
  });

  it('命令执行中切聊天,不滚动新聊天的同号楼层', async () => {
    const element = { scrollIntoView: vi.fn() };
    vi.mocked(ctx.executeSlashCommandsWithOptions!).mockImplementation(async () => {
      ctx.getCurrentChatId = () => '另一聊天';
      query.mockReturnValue(element);
    });
    await expect(jumpToFloor(0)).resolves.toBe(false);
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });

  it('命令执行中楼层消息被替换,不跳转到新消息', async () => {
    const element = { scrollIntoView: vi.fn() };
    vi.mocked(ctx.executeSlashCommandsWithOptions!).mockImplementation(async () => {
      ctx.chat = [{ ...message }];
      query.mockReturnValue(element);
    });
    await expect(jumpToFloor(0)).resolves.toBe(false);
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, 1, NaN])('拒绝无效索引 %s', async floor => {
    await expect(jumpToFloor(floor)).resolves.toBe(false);
    expect(ctx.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
