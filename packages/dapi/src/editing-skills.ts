/** Shared by the app, MCP catalog and both agent providers. Paths are relative to bundled docs. */
export const EDITING_SKILL_VERSION = "1.6.0";
export const EDITING_STYLE_LIMIT = 8000;

export type EditingSkill = {
  id: string;
  title: string;
  description: string;
  path: string;
  version: string;
  category: EditingSkillCategory;
  requires: string[];
};

/**
 * `editing`: a built-in guide. `optional`: an imported guide for a cloud
 * service the user configures separately (its own key, SDK and account).
 * `addon`: an imported guide whose tools run on this Mac through a Cutroom
 * add-on that installs itself, with no account or key. `reference`: links to
 * outside guidance.
 */
export const EDITING_SKILL_CATEGORIES = ["editing", "optional", "addon", "reference"] as const;
export type EditingSkillCategory = (typeof EDITING_SKILL_CATEGORIES)[number];

/** The base guides INSTRUCTIONS.md names as `skills/<id>.md`; listed so `skills` can read them too. */
const base = (id: string, title: string, description: string): EditingSkill => ({
  id, title, description, path: `skills/${id}.md`, version: EDITING_SKILL_VERSION, category: "editing", requires: [],
});
const builtIn = (id: string, title: string, description: string): EditingSkill => ({
  id, title, description, path: `skills/${id}/SKILL.md`, version: EDITING_SKILL_VERSION,
  category: "editing", requires: [],
});
const optional = (id: string, title: string, description: string, requires: string[], category: Exclude<EditingSkillCategory, "editing"> = "optional"): EditingSkill => ({
  id, title, description, path: `skills/imports/${id}/SKILL.md`, version: EDITING_SKILL_VERSION, category, requires,
});

/** What the earshot imports need: Cutroom's audio add-on, which installs itself the first time a sound tool is called. */
const AUDIO_ADDON = ["Audio intelligence add-on (installs by itself on first use, about 2.4 GB; Remove in Settings)", "Mac with Apple silicon"];

export const EDITING_SKILLS: readonly EditingSkill[] = [
  base("editor", "Editor (start here)", "The default guide: understand the footage, build the edit in the project's JSX, and verify it before delivery."),
  base("watch", "Watch footage", "Summarize footage, find moments and quotes, and check claims about a video or audio file without editing it."),
  builtIn("uve-story-selection", "Story & highlights", "Find complete moments, compare hooks and payoffs, and assemble a story grounded in source timestamps."),
  builtIn("uve-dialogue-pacing", "Dialogue pacing", "Tighten repetitions and false starts while preserving meaning, breaths, reactions and timing."),
  builtIn("uve-caption-finishing", "Caption finishing", "Generate captions from the edited scene, correct wording and check timing, line breaks and placement."),
  builtIn("uve-social-reframing", "Social reframing", "Adapt compositions for vertical, square and landscape delivery with deliberate crops and readable text."),
  builtIn("uve-audio-finishing", "Audio finishing", "Measure LUFS and true peak, finish dialogue, add editable music ducking, and cross-check the exported mix."),
  builtIn("uve-music", "Music", "Pick music by mood and pace, fetch an exact song or its official instrumental and check it has no vocals, trim it in source seconds, and mix it under speech with fades and ducking."),
  builtIn("uve-sfx", "Sound effects", "Render or find sparing sound effects, time them to visible events, layer and level them, and keep them out of music ducking."),
  builtIn("uve-personal-style", "Your editing style", "Apply your saved preferences and reference edits while respecting the current project's brief."),
  builtIn("uve-motion-graphics", "Motion graphics", "Create editable titles, overlays and animations using UVE's own composition tools."),
  builtIn("uve-web-media", "Web images & media", "Find openly licensed images, video and audio for a script or B-roll, download them or a link you supply into the project, and keep their credits."),
  builtIn("uve-final-review", "Final review", "Review the story, cuts, framing, captions and audio against the brief before delivery, hearing a draft export for sound sync and loudness."),
  builtIn("uve-performance-insights", "Performance insights", "Use available Instagram observations to propose measurable editing experiments."),
  optional("uve-cloud-transcribe", "Cloud transcription", "Optional OpenAI transcription with speaker labels. Local Whisper remains the default.", ["Python 3.9+", "OpenAI Python SDK", "OPENAI_API_KEY", "Separate API service"]),
  optional("uve-cloud-speech", "Generated narration", "Optional OpenAI speech generation with built-in voices and controllable delivery.", ["Python 3.9+", "OpenAI Python SDK", "OPENAI_API_KEY", "Separate API service"]),
  optional("uve-remotion-reference", "Remotion reference", "Links to official motion-design guidance. UVE edits continue to use the UVE renderer.", ["Internet access for reference pages"], "reference"),
  optional("earshot-listening", "Listening with audio models", "Judge, pick, trim and verify sounds with local audio models: vocals checks, sync to cuts, loudness, A/B of a change, and effects rendered from earshot's bank.", AUDIO_ADDON, "addon"),
  optional("earshot-real-sound", "Real sound for a film", "Build a launch-film soundtrack from licensed real recordings, placed on cue frames, measured, critiqued and finished with local audio models.", AUDIO_ADDON, "addon"),
];

export type EditingStyle = { version: 1; revision: number; notes: string; updatedAt: string | null };
