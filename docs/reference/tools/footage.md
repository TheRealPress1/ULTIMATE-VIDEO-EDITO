# Search footage and build a cut

The Footage panel and `footage_index`, `footage_search`, and `footage_cut` tools share the same local transcript index and scene builder. Open a project and import its sources before using these tools.

1. Run `footage_index` with no arguments to index imported audio/video, or set `paths` to a list of library paths. Sources must be local and no longer than two hours. First use downloads the Whisper base model; recording contents stay on this computer. Read the returned statuses: `ready` has recognized speech, `no-speech` is a completed empty result, `partial` exposes completed/total sections and can resume, and `error` needs attention.
2. Call `footage_search` with a spoken word or phrase. An empty query browses passages; `path` restricts the source and `limit` caps returned matches. This is literal transcript search. It does not recognize visual subjects or identify speakers. Preview the original recording and verify the context and recognition.
3. Call `footage_cut` with a `passages` array in the desired story order. For each match retain `assetId`, `fingerprint`, `sourceIn`, and `sourceOut`. Do not replace source times with timeline times. Optionally supply a scene `name`, `width`, and `height`. The app looks up the trusted indexed words itself and rejects changed recordings.
4. Review the returned new scene with `context`, `capture`, and `check`, then inspect joins and captions. Recognition is imperfect; preserving the speaker's meaning remains an editorial decision.

Each selected passage becomes an editable media clip. Captions follow the assembled timeline, and existing scenes and original recordings stay intact. A cut accepts up to 100 passages. A query's total may exceed its result limit; narrow the query or filter by path to see the relevant passages.

Source speech is decoded in five-minute sections with two seconds of overlap on either side. Completed sections are saved with the source SHA, engine, language and timing settings. **Resume** or another `footage_index` call processes only missing sections; only the completed transcript is searchable. Boundary words are assigned to one section and deduplicated.

The index lives in the project's `.cutroom/footage-index.json`. Full-file content fingerprints let identical footage reuse its transcript after a rename or copy, including after restarting UVE. Source modifications invalidate the old match. Missing files and damaged index records are reported instead of silently treated as successful indexing. Collect Project excludes hidden metadata, so the collected project's transcripts are rebuilt from its originals when indexed.
