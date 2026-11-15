import { describe, expect, it } from 'vitest';

import { speechSectionVariant } from './speech-variant';

describe('saved transcription sections', () => {
  it('keeps the default run on its old key, so sections saved before still resume', () => {
    expect(speechSectionVariant()).toEqual([]);
    expect(speechSectionVariant('fast')).toEqual([]);
  });

  it('keeps sections apart by model and language', () => {
    expect(speechSectionVariant('accurate')).toEqual(['accurate', 'auto']);
    expect(speechSectionVariant('fast', 'es')).toEqual(['fast', 'es']);
    expect(speechSectionVariant('accurate', 'es')).not.toEqual(speechSectionVariant('accurate'));
  });
});
