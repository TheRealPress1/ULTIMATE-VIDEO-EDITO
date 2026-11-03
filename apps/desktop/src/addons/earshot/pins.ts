/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Everything the audio intelligence add-on installs, pinned: one uv release,
// one Python minor (uv verifies its own builds), one torch, one earshot
// commit, one FFmpeg build and the two model revisions earshot itself pins.
// Every file Cutroom downloads itself is checked against the SHA-256 written
// here, the torch wheel included; the other Python packages resolve as of
// earshot's release date, so a later release on PyPI never changes what gets
// installed.
//
// Checked 2026-11-03: the uv digests against the release's `.sha256` files,
// GitHub's asset digests and a local `shasum -a 256`; the FFmpeg digests
// against the build server's `.sha256` files and a local hash of the arm64
// zips; the earshot archive by hashing two separate downloads; the torch
// wheel against the digest PyTorch's CPU index lists, the checksum its
// server sends and a local hash.

/** The Mac architectures the add-on knows, as Node spells them. */
export type EarshotArch = "arm64" | "x64";

export type PinnedFile = { url: string; sha256: string; bytes: number };

/** earshot (MIT) at its 0.4.0 release commit. */
export const EARSHOT = {
  version: "0.4.0",
  commit: "591fa3e028032e6dce56620a20e932e35667e8d8",
  /** The commit's date: Python packages resolve as of this moment (`uv --exclude-newer`). */
  released: "2026-10-22T10:07:51Z",
  repository: "https://github.com/Leonxlnx/earshot",
  license: "MIT",
  /**
   * The source at the commit, as GitHub serves it. Installed from this file
   * rather than `git+https://`, because uv clones with the system `git`, and
   * on a Mac without the Command Line Tools that opens Apple's install dialog.
   */
  archive: {
    url: "https://github.com/Leonxlnx/earshot/archive/591fa3e028032e6dce56620a20e932e35667e8d8.tar.gz",
    sha256: "dff3b63247e11c01e4c433357071e38a686e98ea2598ac2a0b186a9e6dd1a670",
    bytes: 3_437_854,
  } satisfies PinnedFile,
} as const;

/** uv 0.13.7 (astral-sh/uv, released 2026-11-03): the binary that installs Python and the packages. */
export const UV = {
  version: "0.13.7",
  assets: {
    arm64: {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-aarch64-apple-darwin.tar.gz",
      sha256: "81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731",
      bytes: 14_347_867,
    },
    x64: {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-apple-darwin.tar.gz",
      sha256: "20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7",
      bytes: 17_026_382,
    },
  } satisfies Record<EarshotArch, PinnedFile>,
  /** The binary's path inside each archive. */
  member: { arm64: "uv-aarch64-apple-darwin/uv", x64: "uv-x86_64-apple-darwin/uv" } satisfies Record<EarshotArch, string>,
} as const;

/** The uv-managed CPython minor earshot runs on. */
export const PYTHON = "3.12";

/**
 * torch from PyTorch's CPU index. 2.11.0 is the newest release whose macOS
 * wheel still runs on macOS 11; 2.12 and later need macOS 14. PyTorch has
 * shipped no Intel macOS wheel since 2.2.2, and earshot needs torch 2.6 or
 * later, so the model tools need Apple silicon. The one wheel that fits
 * (CPython 3.12, Apple silicon) is fetched and checked like the files below
 * and installed from that copy: the index can replace a file under the same
 * name, which PyPI never does, and uv would only compare it with the digest
 * the same index lists.
 */
export const TORCH = {
  version: "2.11.0",
  wheel: {
    url: "https://download.pytorch.org/whl/cpu/torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl",
    sha256: "43b35116802c85fb88d99f4a396b8bd4472bfca1dd82e69499e5a4f9b8b4e252",
    bytes: 80_512_593,
  } satisfies PinnedFile,
} as const;

export const PYPI_INDEX = "https://pypi.org/simple";

/**
 * FFmpeg 9.0.2 static builds for macOS by Martin Riedl
 * (https://ffmpeg.martin-riedl.de): signed with a Developer ID, one binary
 * per zip, a published SHA-256 per file, arm64 and Intel. GPL v3 builds
 * (x264, x265, lame, opus…), downloaded on the user's Mac and never shipped
 * inside Cutroom. The bundled FFmpeg is an LGPL, audio-only build (AAC, MP3,
 * Opus, Vorbis, FLAC and PCM, a few containers, no video decoder at all);
 * earshot reads picture cuts and frames, which takes H.264 and the other
 * video decoders, and any codec or container a user's media comes in.
 */
export const FFMPEG = {
  version: "9.0.2",
  source: "https://ffmpeg.martin-riedl.de",
  license: "GPL-3.0-or-later",
  arm64: {
    ffmpeg: {
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
      sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
      bytes: 28_395_699,
    },
    ffprobe: {
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
      sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
      bytes: 28_317_701,
    },
  },
  x64: {
    ffmpeg: {
      url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
      sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
      bytes: 33_816_391,
    },
    ffprobe: {
      url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip",
      sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
      bytes: 33_719_233,
    },
  },
} as const;

export const FFMPEG_FILES: Record<EarshotArch, Record<"ffmpeg" | "ffprobe", PinnedFile>> = { arm64: FFMPEG.arm64, x64: FFMPEG.x64 };

/**
 * The model files earshot loads (its `config.PINS`): where `earshot doctor
 * --fetch` puts them under EARSHOT_HOME, so a ready install can be told
 * from the disk alone.
 */
export const MODELS = [
  { id: "laion/larger_clap_general", revision: "16c8cc3159a3c8a31e8ff5ef1f66b0d9ab3667db", weights: "model.safetensors" },
  { id: "MIT/ast-finetuned-audioset-10-10-0.4593", revision: "f826b80d28226b62986cc218e5cec390b1096902", weights: "model.safetensors" },
] as const;

/**
 * The hosts Cutroom itself downloads from (uv, earshot's source, torch,
 * FFmpeg) and the ones they redirect to: GitHub's asset hosts, and the
 * mirror PyTorch's index links the same wheels from.
 */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "download.pytorch.org",
  "download-r2.pytorch.org",
  "ffmpeg.martin-riedl.de",
]);

/** What one install records per step, so a Cutroom update that moves a pin re-runs exactly the steps it changes. */
export const STEP_PINS = {
  uv: `uv ${UV.version}`,
  python: `cpython ${PYTHON} via uv ${UV.version}`,
  packages: `earshot ${EARSHOT.commit} torch ${TORCH.version} as of ${EARSHOT.released}`,
  ffmpeg: `ffmpeg ${FFMPEG.version}`,
  models: MODELS.map((model) => `${model.id}@${model.revision}`).join(" "),
} as const;
