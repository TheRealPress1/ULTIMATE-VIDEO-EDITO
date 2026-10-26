import { describe, expect, it, vi } from 'vitest';
import { EncodedVideoPacketSource, Mp4OutputFormat, Output, type StreamTargetChunk } from 'mediabunny';
import { TargetBuffer } from '../../../../packages/encoder/src/buffer';

async function fixture() {
  let published = 'last valid export';
  const staged: Uint8Array[] = [];
  const close = vi.fn(() => { published = 'new export'; });
  const abort = vi.fn(() => { staged.length = 0; });
  const stream = new WritableStream<StreamTargetChunk>({ write: (chunk) => { staged.push(chunk.data); }, close, abort });
  const buffer = await TargetBuffer.create({ createWritable: async () => stream });
  const output = new Output({ format: new Mp4OutputFormat(), target: buffer.target });
  output.addVideoTrack(new EncodedVideoPacketSource('avc'));
  return { buffer, output, close, abort, staged, published: () => published };
}

describe('export output transaction', () => {
  it('does not commit when the real muxer closes its target during cancellation', async () => {
    const { buffer, output, close, abort, published } = await fixture();
    await output.start();
    await output.cancel();
    expect(close).not.toHaveBeenCalled();
    await buffer.abort(new Error('Missing media'));
    expect(abort).toHaveBeenCalledOnce();
    expect(published()).toBe('last valid export');
  });

  it('commits once only after successful finalization', async () => {
    const { buffer, output, close, abort, published } = await fixture();
    await output.start();
    await output.finalize();
    expect(close).not.toHaveBeenCalled();
    expect(published()).toBe('last valid export');
    await buffer.close();
    expect(close).toHaveBeenCalledOnce();
    expect(published()).toBe('new export');
    expect(abort).not.toHaveBeenCalled();
  });

  it('can abort setup failure before the muxer starts', async () => {
    const { buffer, close, abort, published } = await fixture();
    await buffer.abort(new Error('Audio worklet unavailable'));
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(published()).toBe('last valid export');
  });
});
