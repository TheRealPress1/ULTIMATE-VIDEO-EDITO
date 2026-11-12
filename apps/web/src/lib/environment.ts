/** Cutroom runs locally by default. Hosted services require an explicit opt-in. */
export const LOCAL_MODE = import.meta.env.VITE_ENABLE_CLOUD !== 'true';

export const CLOUD_UNAVAILABLE_MESSAGE =
  'Hosted generation is not configured in Blackout. Connect Claude Code or Codex for editing, or use the local media tools.';
