import { createSignal } from 'solid-js';
import { registerProjectSaveParticipant, type ProjectSaveState } from './edits';

/** Serialized replacement writes for manifests/settings, journaled before IPC. */
export class DurableProjectValue<T> {
	private pending: { value: T } | undefined;
	private running: Promise<void> | undefined;
	private failure: Error | undefined;
	private readonly status = createSignal<ProjectSaveState>({ status: 'saved' });
	private readonly unregister: () => void;
	private detached = false;
	private unreadable = false;
	private readonly key: string;

	public constructor(dir: string, private readonly kind: string, private readonly write: (value: T) => Promise<void>) {
		this.key = `cutroom:pending-value:v1:${kind}:${dir}`;
		this.unregister = registerProjectSaveParticipant(dir, this);
		try {
			this.readJournal();
			if (this.pending) this.status[1]({ status: 'saving' });
		} catch (error) {
			this.unreadable = true;
			this.fail(this.readError(error));
		}
	}

	private readJournal(): void {
		const raw = localStorage.getItem(this.key);
		if (!raw) {
			this.pending = undefined;
			return;
		}
		const journal = JSON.parse(raw);
		if (journal?.version !== 1 || !Object.hasOwn(journal, 'value')) throw new Error('Invalid recovery record');
		this.pending = { value: journal.value as T };
	}

	private readError(error: unknown): Error {
		return new Error(`Could not read the ${this.kind} recovery record. It has been kept; no file has been overwritten. ${String(error)}`);
	}

	public state = (): ProjectSaveState => this.status[0]();

	public set(value: T): void {
		if (this.unreadable) throw this.failure;
		this.pending = { value: structuredClone(value) };
		try { this.persist(); }
		catch (error) { throw this.fail(error); }
		if (!this.failure) this.status[1]({ status: 'saving' });
	}

	private persist(): void {
		try {
			if (this.pending) localStorage.setItem(this.key, JSON.stringify({ version: 1, value: this.pending.value }));
			else localStorage.removeItem(this.key);
		} catch (error) { throw new Error(`Could not store pending project changes for recovery: ${String(error)}. Keep this project open and retry saving.`); }
	}

	private fail(error: unknown): Error {
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.status[1]({ status: 'error', error: this.failure.message });
		return this.failure;
	}

	public flush(): Promise<void> {
		if (this.running) return this.running;
		if (this.failure) return Promise.reject(this.failure);
		if (!this.pending) {
			if (this.detached) this.unregister();
			return Promise.resolve();
		}
		this.running = this.drain().finally(() => {
			this.running = undefined;
			if (!this.failure && !this.pending) {
				this.status[1]({ status: 'saved', savedAt: Date.now() });
				if (this.detached) this.unregister();
			}
		});
		return this.running;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending) {
				this.persist();
				const current = this.pending;
				await this.write(current.value);
				// Newer full values supersede older ones, but never write in parallel.
				if (this.pending === current) this.pending = undefined;
				this.persist();
			}
		} catch (error) { throw this.fail(error); }
	}

	public retry(): Promise<void> {
		if (this.running) return this.running;
		// Reading storage can fail temporarily too. Retry the read before any
		// writes, while continuing to preserve a record that is still corrupt.
		if (this.unreadable) {
			try { this.readJournal(); }
			catch (error) { return Promise.reject(this.fail(this.readError(error))); }
			this.unreadable = false;
		}
		this.failure = undefined;
		try { this.persist(); }
		catch (error) { return Promise.reject(this.fail(error)); }
		this.status[1]({ status: this.pending ? 'saving' : 'saved' });
		return this.flush();
	}

	public dispose(): void {
		this.detached = true;
		if (!this.pending && !this.running && !this.failure) this.unregister();
		else void this.flush().catch(() => { /* The registered participant retains the retry action. */ });
	}
}
