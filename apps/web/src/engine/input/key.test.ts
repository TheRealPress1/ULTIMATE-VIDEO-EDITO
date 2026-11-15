import { describe, expect, it } from 'vitest';
import { keyOf } from './key';

const press = (key: string, code: string, altKey = false) => keyOf({ key, code, altKey });

describe('the key a shortcut names', () => {
  it('is the typed key, in lower case', () => {
    expect(press('x', 'KeyX')).toBe('x');
    expect(press('X', 'KeyX')).toBe('x');
    expect(press('Backspace', 'Backspace')).toBe('backspace');
    expect(press('ArrowLeft', 'ArrowLeft')).toBe('arrowleft');
  });

  it('is the letter on the key when Option has changed what the key types (⌥X types ≈)', () => {
    expect(press('≈', 'KeyX', true)).toBe('x');
    expect(press('å', 'KeyA', true)).toBe('a');
    expect(press('Dead', 'KeyE', true)).toBe('e');
    expect(press('¡', 'Digit1', true)).toBe('1');
  });

  it('leaves keys that are not letters or digits as they are with Option held', () => {
    expect(press('Alt', 'AltLeft', true)).toBe('alt');
    expect(press('Enter', 'Enter', true)).toBe('enter');
    expect(press('ArrowRight', 'ArrowRight', true)).toBe('arrowright');
  });

  it('follows the layout, not the position of the key, without Option (a QWERTZ keyboard types z where QWERTY has y)', () => {
    expect(press('z', 'KeyY')).toBe('z');
  });
});
