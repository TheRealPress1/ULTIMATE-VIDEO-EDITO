/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trait } from 'koota';

import type { ShaderHost } from '../media/shader';
import type { ImageDecoder } from '../media/image';
import type { VideoDecoderInstance } from '../media/video';
import type { AudioDecoder } from '../media/audio';
import type { CaptionDecoder } from '../media/caption/types';
import type { Waveform } from '../media/audio-peaks';
import type { AudioBus } from '../media/audio-bus';
import type { VideoAsset } from '@diffusionstudio/assets';

// Renderer-runtime state on mounted entities (never serialized).
export type MountData = {
	props: Record<string, unknown>;
	textBox?: DocumentFragment;
};

// Handle traits store live runtime instances (decoders, buses, etc.) and are
// never serialized. They use AoS storage: entity.get(X) returns the instance
// directly.

export const ShaderHostHandle = trait(() => null as ShaderHost | null);

export const ImageDecoderHandle = trait(() => null as ImageDecoder | null);

export const VideoDecoderHandle = trait(() => null as VideoDecoderInstance | null);

/** Preview-only derived media. Never added to the library or serialized into JSX. */
export interface PlaybackProxyBinding {
	identity: string;
	asset: VideoAsset;
	onFailure?: () => void;
}

export interface PlaybackProxyState {
	enabled: boolean;
	entries: Map<string, PlaybackProxyBinding>;
}

// Offline worlds deliberately do not inherit this map. The decoder also gates
// it by Mode so temporarily rendering a live world offline cannot use a proxy.
export const PlaybackProxies = trait(() => null as PlaybackProxyState | null);

export const AudioDecoderHandle = trait(() => null as AudioDecoder | null);

export const WaveformHandle = trait(() => null as Waveform | null);

export const CaptionDecoderHandle = trait(() => null as CaptionDecoder | null);

export const AudioBusHandle = trait(() => null as AudioBus | null);

export const Data = trait(() => null as MountData | null);
