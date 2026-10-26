import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ randomInt: vi.fn() }));
vi.mock('node:crypto', async (original) => {
	const actual = await original<typeof import('node:crypto')>();
	return { ...actual, randomInt: mocks.randomInt };
});
import { applyEdits } from './edit';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'numeric-id-edit-'));
	mocks.randomInt.mockReset().mockReturnValue(parseInt('abcdef', 36));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('stable source identity during cut undo', () => {
	it('saves a whole-subtree undo containing an existing all-digit caption id', async () => {
		await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage">
  <scene id="original" width={1920} height={1080}><video id="originalVideo" src="original.mp4" /></scene>
  <scene id="cutScene" width={1920} height={1080}>
    <solidPaint id="background" color="#000000" />
    <rect id="cutClip"><videoPaint id="cutPaint" src="original.mp4" /></rect>
    <captions id="869438" src="cut.json" selected />
  </scene>
</stage>;`);
		const result = await applyEdits({ dir, strict: true }, ['869438', 'cutPaint', 'cutClip', 'background', 'cutScene'].map((id) => ({ kind: 'remove', source: `index.tsx:${id}` })));
		expect(result).toEqual({ skipped: [] });
		const source = await readFile(join(dir, 'index.tsx'), 'utf8');
		expect(source).toContain('<scene id="original"');
		expect(source).toContain('<video id="originalVideo"');
		expect(source).not.toContain('cutScene');
		expect(source).not.toContain('869438');
	});

	it('rejects a numeric address with different positional and named targets', async () => {
		const source = 'export default () => <scene><video id="first" /><captions id="1" /></scene>;';
		await writeFile(join(dir, 'index.tsx'), source);
		const result = await applyEdits({ dir, strict: true }, [{ kind: 'remove', source: 'index.tsx:1' }]);
		expect(result.skipped).toEqual(['index.tsx:1']);
		expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe(source);
	});

	it('continues supporting ordinary anonymous positional edits', async () => {
		await writeFile(join(dir, 'index.tsx'), 'export default () => <scene><video /><captions /></scene>;');
		expect(await applyEdits({ dir, strict: true }, [{ kind: 'remove', source: 'index.tsx:2' }])).toEqual({ skipped: [] });
		expect(await readFile(join(dir, 'index.tsx'), 'utf8')).not.toContain('<captions');
	});

	it.each(['000123', '0001e2', '0x0123'])('preserves the exact spelling of legacy numeric-looking id %s', async (id) => {
		await writeFile(join(dir, 'index.tsx'), `export default () => <scene><captions id="${id}" /></scene>;`);
		expect(await applyEdits({ dir, strict: true }, [{ kind: 'remove', source: `index.tsx:${id}` }])).toEqual({ skipped: [] });
		expect(await readFile(join(dir, 'index.tsx'), 'utf8')).not.toContain('<captions');
	});

	it('never allocates numeric-looking ids, including exponent notation', async () => {
		await writeFile(join(dir, 'index.tsx'), 'export default () => <scene id="scene" />;');
		mocks.randomInt.mockReturnValueOnce(parseInt('869438', 36)).mockReturnValueOnce(parseInt('0001e2', 36));
		const result = await applyEdits({ dir, strict: true }, [{ kind: 'insert', source: 'pending#caption', parent: 'index.tsx:scene', tag: 'captions', props: { src: 'cut.json' } }]);
		expect(result.skipped).toEqual([]);
		expect(result.ids).toEqual({ 'pending#caption': 'index.tsx:abcdef' });
		expect(mocks.randomInt).toHaveBeenCalledTimes(3);
	});
});
