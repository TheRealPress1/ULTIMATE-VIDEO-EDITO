# Using local speech evidence

[`listen`](../../reference/tools/listen.md) returns local speech transcription for a source window of up to two hours. Its optional prompt is context for the editing agent; no audio-language model answers the question. For longer transcripts, use `transcribe`.

Useful requests include “get speech evidence for the opening 30 seconds” or “find the words around this proposed cut.” Use `start` and `end` to choose the source window. Returned word times are relative to that window; `sourceStart` and `sourceEnd` give source times for editing.

This speech tool does not support speaker diarization, voice identity, host/guest roles, music identification or active-speaker tracking. Do not infer a speaker's identity from this transcript or assign speaker labels because a prompt names a person. Summaries should be based on the recognized words and should preserve uncertainty where recognition is unclear.

For a request to follow whoever is talking, use `reframe` with `mode: "speakers"`. Its separate local audio/video model follows supported visible-speaker evidence, with a hold or wide view when uncertain. Review its coverage and resulting framing. Plain `follow` mode uses face continuity without identifying the active speaker.
