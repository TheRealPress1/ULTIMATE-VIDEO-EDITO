/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SpeechQuality } from '@desktop/speech-types';

/**
 * What tells a saved transcription section's model and language apart. The
 * default run (fast model, detected language) has none, so sections saved
 * before quality and language could be chosen keep their keys and resume.
 */
export function speechSectionVariant(quality?: SpeechQuality, language?: string): string[] {
  return quality === 'accurate' || language ? [quality ?? 'fast', language ?? 'auto'] : [];
}
