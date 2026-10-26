---
name: uve-story-selection
description: Select strong moments and assemble a coherent story from existing footage, with source timestamps and reasons for each editorial choice.
metadata:
  version: "1.1.0"
---

# Story selection

Use the current project and brief. Establish the audience, desired length, format, and main point from the request and existing notes. An analysis request produces selects; an editing request can proceed to assembly without an extra approval round.

Probe the relevant sources. For imported footage, use `footage_index` to build or refresh its persistent local speech index, optionally restricted to library paths, then `footage_search` for relevant phrases or an empty query to browse passages. Check per-asset indexing errors; missing or changed media needs attention before selecting its speech. Keep result asset IDs, fingerprints, and source ranges together. These tools search recognized speech literally, not visual concepts. For a standalone transcript file, use local `transcribe`. Read the [footage workflow](../../reference/tools/footage.md) and [transcription limits](../../reference/tools/transcribe.md). Search for complete exchanges, then inspect adjacent context and sampled frames. A waveform supplies pause candidates, not an editorial verdict. Local recognition does not identify speakers or describe emotion. Label uncertain speakers neutrally and verify visual claims with frames.

Compare candidates by intelligibility without prior context, specificity, relevance, development, and a satisfying ending. A quieter explanation can beat a dramatic sentence whose meaning depends on omitted context. Preserve qualifications, the question being answered, and who said what. Do not splice separate statements into a new claim or turn an emotional pause into a factual contradiction.

For each selected span, record the source path, source in/out in seconds, proposed timeline placement, a short reason, and any verification still needed. Distinguish measured duration from subjective editorial judgment; do not call a score a prediction of virality.

When assembly is requested, call `footage_cut` with selected passage references in story order and a useful scene name. It resolves trusted indexed words, rechecks the recordings, and creates a new editable scene with timeline-aligned captions. If a fingerprint is stale, refresh indexing and review the replacement passage before retrying. Keep source ranges separate from timeline positions and preserve the original media. For manual adjustments, use explicit starts and the [timing reference](../../reference/jsx/timing.md). Add B-roll only when it supports an identifiable point. For alternatives, create named scene variants rather than overwrite an approved cut.

Inspect the opening, ending, and every changed join in context. Use [final review](../uve-final-review/SKILL.md) before presenting a substantial edit. Report the selected story and material omissions briefly.
