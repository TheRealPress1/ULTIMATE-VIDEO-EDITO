/** Rebuildable observations, never authored timeline state. */
export interface AnalysisCacheRequest { id?: string; dir: string; key: string; sources: string[] }
export interface AnalysisCacheResult { fingerprint: string; chunks: Record<string, unknown> }
export interface AnalysisCachePut extends AnalysisCacheRequest { fingerprint: string; chunk: string; value: unknown }
