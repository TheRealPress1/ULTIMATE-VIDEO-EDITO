import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  request: vi.fn(),
}));
vi.mock('@/projects/edits', () => ({ flushProjectEdits: mocks.flush }));
vi.mock('@/init', () => ({ store: { define: (_key: string, value: unknown) => ({ value }) } }));
vi.mock('@/lib/store', async () => {
  const { createSignal } = await import('solid-js');
  return { createStoredSignal: (entry: { value: unknown }) => createSignal(entry.value) };
});
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/hooks/use-project-route', () => ({ projectRoute: (id: string) => `/project/${id}` }));
vi.mock('./attachments', () => ({
  attachmentFromPath: (path: string) => ({ path }),
  attachmentPaths: (items: unknown[]) => items,
  mergeAttachments: (current: { key: string }[], incoming: { key: string }[]) => [...current, ...incoming.filter((item) => !current.some((entry) => entry.key === item.key))],
}));
vi.mock('./connection', () => ({
  hasHost: () => true,
  client: {
    state: 'open',
    request: mocks.request,
    onState: () => () => {},
    onHarnesses: () => () => {},
    open: () => () => {},
    connect() {},
  },
}));

const options = {
  projectId: 'fixture', cwd: '/projects/fixture', chatId: 'chat-fixture',
  text: 'Trim the opening', attachments: [], model: { harness: 'claude' as const, model: 'test' },
};
beforeEach(() => {
  vi.resetModules();
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.request.mockReset().mockResolvedValue({ chatId: 'chat-fixture' });
});

describe('AI actions and pending project saves', () => {
  it('keeps a turn pending until timeline, manifest and settings saves finish', async () => {
    let saved!: () => void;
    mocks.flush.mockReturnValue(new Promise<void>((resolve) => { saved = resolve; }));
    const { send, chatState } = await import('./store');
    const result = send(options);
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith(options.cwd));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(chatState.sending[options.chatId]).toMatchObject({ kind: 'user', text: options.text });
    saved();
    expect(await result).toBe(options.chatId);
    expect(mocks.request).toHaveBeenCalledWith('turn.send', expect.objectContaining({ cwd: options.cwd, text: options.text }));
    expect(chatState.sending[options.chatId]).toBeNull();
  });

  it('does not start the agent after a failed save and allows sending after retry', async () => {
    mocks.flush.mockRejectedValueOnce(new Error('Disk full'));
    const { send, chatState } = await import('./store');
    await expect(send(options)).rejects.toThrow('Disk full');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(chatState.sending[options.chatId]).toBeNull();
    await expect(send(options)).resolves.toBe(options.chatId);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each(['undo', 'redo'] as const)('flushes newer manual edits before asking the host to %s', async (direction) => {
    let saved!: () => void;
    mocks.flush.mockReturnValue(new Promise<void>((resolve) => { saved = resolve; }));
    const { restoreEdit } = await import('./store');
    const result = restoreEdit(options.projectId, 'checkpoint', options.cwd, direction);
    await vi.waitFor(() => expect(mocks.flush).toHaveBeenCalledWith(options.cwd));
    expect(mocks.request).not.toHaveBeenCalled();
    saved();
    await result;
    expect(mocks.request).toHaveBeenCalledWith('edits.restore', { projectId: options.projectId, checkpointId: 'checkpoint', cwd: options.cwd, direction });
  });

  it('preserves the checkpoint and pending edits when the pre-restore save fails', async () => {
    mocks.flush.mockRejectedValue(new Error('Pending edits could not be saved'));
    const { restoreEdit } = await import('./store');
    await expect(restoreEdit(options.projectId, 'checkpoint', options.cwd, 'undo')).rejects.toThrow('Pending edits could not be saved');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('restores an unsent prompt alongside the next instruction already typed', async () => {
    const { setDraftText, restoreDraft, draft } = await import('./store');
    setDraftText(options.chatId, 'Then add captions');
    restoreDraft(options.chatId, { text: options.text, attachments: [] });
    expect(draft(options.chatId).text).toBe('Trim the opening\n\nThen add captions');
  });

  it('does not duplicate a draft the user has already restored', async () => {
    const { setDraftText, restoreDraft, draft } = await import('./store');
    setDraftText(options.chatId, options.text);
    restoreDraft(options.chatId, { text: options.text, attachments: [] });
    expect(draft(options.chatId).text).toBe(options.text);
  });
});
