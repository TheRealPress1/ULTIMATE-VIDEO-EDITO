---
name: uve-cloud-speech
description: Create optional OpenAI narration or voiceover assets for a UVE project when the user requests generated speech.
metadata:
  version: "1.0.0"
---

# Optional generated narration

This workflow sends narration text to OpenAI's separate API service. It is available as an optional skill; connecting Claude Code or Codex does not configure the service. Resolve `<imports>` to the parent of this skill's folder using the absolute skill path from UVE. Run `python3 <imports>/run.py status` to check local Python package and credential presence without contacting OpenAI.

Read the imported [speech skill](../openai/speech/SKILL.md) and only the relevant [voiceover](../openai/speech/references/voiceover.md) or [narration](../openai/speech/references/narration.md) guidance. The imports are pinned and unmodified. Use the UVE launcher rather than the upstream `$CODEX_HOME` example paths.

Use exact approved narration, a built-in voice, and delivery directions that match the brief. If text still needs writing, settle that text before generating paid audio. Establish authorization for sending that text to OpenAI. Python 3.9+, the `openai` Python package, and `OPENAI_API_KEY` are required for live generation. Keep credentials local and never display their values. Dependencies can live in a project virtual environment; this skill does not install them automatically.

Create a project text file for longer narration. Validate the request without a network call:

```text
python3 <imports>/run.py speech --project <project> --text-file narration.txt --output assets/narration-v1.mp3 --voice cedar --instructions "Conversational delivery, measured pace."
```

Add `--execute` for the authorized live request. The launcher defaults to dry-run, writes live output through a temporary file, and refuses to overwrite existing assets. It runs the provider command once; the provider SDK can still retry transient requests. For long narration, split at natural sentence or scene boundaries and generate clips individually; preserve the approved text and timings.

After generation, probe the asset and audition it in the project for pronunciation, pacing, and intelligibility. Add it as an editable audio clip, balance it against music with UVE volume controls, then review the timing against picture. Keep the asset separate from the source video. State that the narration is AI-generated. This workflow does not clone voices, generate music, or supply missing footage.
