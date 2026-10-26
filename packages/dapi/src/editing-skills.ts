/** Shared by the app, MCP catalog and both agent providers. Paths are relative to bundled docs. */
export const EDITING_SKILL_VERSION = "1.3.0";
export const EDITING_STYLE_LIMIT = 8000;

export type EditingSkill = {
  id: string;
  title: string;
  description: string;
  path: string;
  version: string;
  category: "editing" | "optional" | "reference";
  requires: string[];
};

const builtIn = (id: string, title: string, description: string): EditingSkill => ({
  id, title, description, path: `skills/${id}/SKILL.md`, version: EDITING_SKILL_VERSION,
  category: "editing", requires: [],
});
const optional = (id: string, title: string, description: string, requires: string[], category: "optional" | "reference" = "optional"): EditingSkill => ({
  id, title, description, path: `skills/imports/${id}/SKILL.md`, version: EDITING_SKILL_VERSION, category, requires,
});

export const EDITING_SKILLS: readonly EditingSkill[] = [
  builtIn("uve-story-selection", "Story & highlights", "Find complete moments, compare hooks and payoffs, and assemble a story grounded in source timestamps."),
  builtIn("uve-dialogue-pacing", "Dialogue pacing", "Tighten repetitions and false starts while preserving meaning, breaths, reactions and timing."),
  builtIn("uve-caption-finishing", "Caption finishing", "Generate captions from the edited scene, correct wording and check timing, line breaks and placement."),
  builtIn("uve-social-reframing", "Social reframing", "Adapt compositions for vertical, square and landscape delivery with deliberate crops and readable text."),
  builtIn("uve-audio-finishing", "Audio finishing", "Measure LUFS and true peak, finish dialogue, and add editable music ducking."),
  builtIn("uve-personal-style", "Your editing style", "Apply your saved preferences and reference edits while respecting the current project's brief."),
  builtIn("uve-motion-graphics", "Motion graphics", "Create editable titles, overlays and animations using UVE's own composition tools."),
  builtIn("uve-final-review", "Final review", "Review the story, cuts, framing, captions and audio against the brief before delivery."),
  builtIn("uve-performance-insights", "Performance insights", "Use available Instagram observations to propose measurable editing experiments."),
  optional("uve-cloud-transcribe", "Cloud transcription", "Optional OpenAI transcription with speaker labels. Local Whisper remains the default.", ["Python 3.9+", "OpenAI Python SDK", "OPENAI_API_KEY", "Separate API service"]),
  optional("uve-cloud-speech", "Generated narration", "Optional OpenAI speech generation with built-in voices and controllable delivery.", ["Python 3.9+", "OpenAI Python SDK", "OPENAI_API_KEY", "Separate API service"]),
  optional("uve-remotion-reference", "Remotion reference", "Links to official motion-design guidance. UVE edits continue to use the UVE renderer.", ["Internet access for reference pages"], "reference"),
];

export type EditingStyle = { version: 1; revision: number; notes: string; updatedAt: string | null };
