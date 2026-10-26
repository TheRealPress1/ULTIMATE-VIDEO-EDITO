---
name: uve-cloud-transcribe
description: Use optional OpenAI cloud transcription for speaker-labeled interviews or explicitly requested cloud transcripts in UVE.
metadata:
  version: "1.0.0"
---

# Optional cloud transcription

Use UVE's local `transcribe` tool for ordinary timed captions. This optional workflow sends audio to OpenAI and uses its separate API service. A Claude Code or Codex connection does not configure it. Check prerequisites with `python3 <imports>/run.py status`; this reports presence only and does not contact the service. `<imports>` is the parent of this skill's folder, resolved from the absolute skill path returned by UVE.

Read [the imported transcription skill](../openai/transcribe/SKILL.md) and its [API reference](../openai/transcribe/references/api.md) for task-specific options. The files are a pinned, unmodified upstream import. Use the UVE launcher below instead of upstream `$CODEX_HOME` paths: the import belongs to the app and serves both agents.

Before a live call, establish that the user wants this source audio uploaded to OpenAI and understands that a separate API service is needed. Do not upload footage merely because this skill is installed. Credentials stay in the process environment; never ask for a key in chat or print it. Python 3.9+ and the `openai` Python package are required for live calls. A project-local virtual environment can supply the package without changing the system Python.

Run a dry-run first, replacing paths with the active local project and a new filename:

```text
python3 <imports>/run.py transcribe --project <project> --input assets/interview.wav --output transcripts/interview-speakers.json --format diarized_json
```

The command validates inputs and prints the request without calling OpenAI. Add `--execute` only for the authorized live request. Use `--format text` with a `.txt` output for a plain transcript, or `--format json` for structured text. The launcher selects the diarization model for `diarized_json`, rejects inputs above 25 MB, keeps outputs in the project, and never replaces an existing output. It does not install packages or credentials.

For a large source, prepare a compressed audio derivative or use speech-boundary chunks with absolute source offsets recorded. Check overlapping boundaries before combining chunks. Speaker labels from diarization identify consistent voices, not verified real-world identities; use source evidence or user-provided names to label them. Do not mistake segment-level timestamps for word timing or pass cloud JSON directly to UVE captions without validating the required transcript format. Keep local word-timed transcription for precise cut points when cloud output lacks it.

Verify names and selected quotes against the source, retain the original transcript, and report any uncertain speaker assignments. The launcher supports one file per invocation; do not retry a failed paid request indefinitely.
