import { afterEach, expect, it, vi } from 'vitest';
import { SaveGate } from './save-gate';
afterEach(() => vi.useRealTimers());
it('waits for the matching renderer and ignores unrelated replies', async () => {
  const gate = new SaveGate(); let id = '';
  const done = vi.fn();
  const pending = gate.request(42, (request) => { id = request; }).then(done);
  gate.answer(43, id); gate.answer(42, 'other');
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  gate.answer(42, id); await pending; expect(done).toHaveBeenCalledOnce();
});
it('keeps the window open when saving fails', async () => {
  const gate = new SaveGate(); let id = '';
  const pending = gate.request(42, (request) => { id = request; });
  gate.answer(42, id, 'Disk full');
  await expect(pending).rejects.toThrow('Disk full');
});
it('does not treat an unresponsive renderer as saved', async () => {
  vi.useFakeTimers();
  const gate = new SaveGate();
  const pending = gate.request(42, () => {}, 100);
  const assertion = expect(pending).rejects.toThrow('did not confirm');
  await vi.advanceTimersByTimeAsync(100); await assertion;
});
