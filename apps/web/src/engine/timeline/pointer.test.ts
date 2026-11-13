import { describe, expect, it } from 'vitest';
import { createPointer } from './pointer';

const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) } as unknown as HTMLCanvasElement;
const event = (x: number, y: number) => ({ button: 0, clientX: x, clientY: y, shiftKey: false }) as PointerEvent;

describe('the timeline pointer', () => {
  it('goes from pressed to pressing to lifted to idle, a frame at a time', () => {
    const pointer = createPointer({ canvas });
    pointer.down(event(10, 10));
    expect(pointer.position?.state).toBe('pressed');
    pointer.reset();
    expect(pointer.position?.state).toBe('pressing');
    pointer.move(event(40, 10));
    expect(pointer.position).toMatchObject({ state: 'pressing', deltaX: 30 });
    pointer.up(event(40, 10));
    expect(pointer.position?.state).toBe('lifted');
    pointer.reset();
    expect(pointer.position?.state).toBe('idle');
  });

  it('is idle at once when a hold is taken away rather than let go, wherever it was', () => {
    const pointer = createPointer({ canvas });
    pointer.down(event(10, 10));
    pointer.reset();
    pointer.move(event(50, 12));

    pointer.cancel();
    expect(pointer.position).toEqual({ state: 'idle', currentX: 50, currentY: 12 });

    // And it stays that way: nothing left to lift, nothing left to drag.
    pointer.reset();
    pointer.up(event(50, 12));
    expect(pointer.position?.state).toBe('idle');
  });

  it('has nothing to cancel when nothing is held', () => {
    const pointer = createPointer({ canvas });
    pointer.cancel();
    expect(pointer.position).toBeNull();

    pointer.move(event(5, 5));
    pointer.cancel();
    expect(pointer.position).toEqual({ state: 'idle', currentX: 5, currentY: 5 });
  });
});
