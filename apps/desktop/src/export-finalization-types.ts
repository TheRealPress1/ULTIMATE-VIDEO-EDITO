/** Internal PCM MOV → requested container. Never accepts arbitrary encoder arguments. */
export type ExportFinalization = { format: 'mp4' | 'mov'; audioBitrate: number };
