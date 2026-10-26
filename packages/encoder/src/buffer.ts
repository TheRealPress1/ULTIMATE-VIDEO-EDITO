/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BufferTarget, StreamTarget, Target } from 'mediabunny';

import type { ContainerFormat, WritableFileTarget } from './types';
import type { StreamTargetChunk } from 'mediabunny';

export class TargetBuffer {
  public target: Target;
  public fastStart: false | 'in-memory';
  public handle: FileSystemFileHandle | WritableFileTarget | undefined;
  private writer: WritableStreamDefaultWriter<StreamTargetChunk> | undefined;

  public constructor(
    target: StreamTarget | BufferTarget,
    fastStart: false | 'in-memory',
    handle: FileSystemFileHandle | WritableFileTarget | undefined
  ) {
    this.target = target;
    this.fastStart = fastStart;
    this.handle = handle;
  }

  public static async create(
    handle?: FileSystemFileHandle | WritableFileTarget
  ): Promise<TargetBuffer> {
    if (handle) {
      const fileStream = await handle.createWritable();
      const writer = (fileStream as WritableStream<StreamTargetChunk>).getWriter();
      // Mediabunny closes its target on cancel as well as finalize. Keep that
      // close separate from committing the file: only a successful render may
      // replace an existing export. Failure/cancel aborts the real writer.
      const stream = new WritableStream<StreamTargetChunk>({
        write: (chunk) => writer.write(chunk),
      });
      const buffer = new TargetBuffer(new StreamTarget(stream, { chunked: true }), false, handle);
      buffer.writer = writer;
      return buffer;
    }

    return new TargetBuffer(new BufferTarget(), 'in-memory', undefined);
  }

  public async close(format: ContainerFormat = 'mp4'): Promise<Blob | undefined> {
    if (this.writer) {
      await this.writer.close();
      this.writer.releaseLock();
      this.writer = undefined;
    }
    if (this.fastStart === 'in-memory' && this.target instanceof BufferTarget) {
      if (!this.target.buffer) return;
      return new Blob([this.target.buffer], { type: mimeTypes[format] });
    }

    return undefined;
  }

  public async abort(reason?: unknown): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    try { await writer.abort(reason); }
    finally {
      writer.releaseLock();
      this.writer = undefined;
    }
  }
}

const mimeTypes: Record<ContainerFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mov: 'video/quicktime',
};
