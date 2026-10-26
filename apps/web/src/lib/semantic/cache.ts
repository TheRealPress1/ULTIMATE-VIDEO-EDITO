import { openDB } from 'idb';
import { semanticEvictions, semanticKey, validSemanticRecord, type SemanticRecord } from './math';
const database = () => openDB('uve-description-embeddings-v1', 1, { upgrade(db) { db.createObjectStore('vectors', { keyPath: 'key' }); } });
export async function readSemanticRecord(fingerprint: string, times: readonly number[]): Promise<SemanticRecord | undefined> {
  const db = await database();
  try {
    const record = await db.get('vectors', semanticKey(fingerprint));
    if (!validSemanticRecord(record, fingerprint, times)) { if (record) await db.delete('vectors', semanticKey(fingerprint)); return undefined; }
    record.usedAt = Date.now(); await db.put('vectors', record); return record;
  } finally { db.close(); }
}
export async function writeSemanticRecord(record: SemanticRecord): Promise<void> {
  if (!validSemanticRecord(record, record.fingerprint, record.times)) throw new Error('Invalid description index.');
  const db = await database();
  try {
    const tx = db.transaction('vectors', 'readwrite');
    await tx.store.put(record);
    const records = await tx.store.getAll() as SemanticRecord[];
    for (const key of semanticEvictions(records)) await tx.store.delete(key);
    await tx.done;
  } finally { db.close(); }
}
