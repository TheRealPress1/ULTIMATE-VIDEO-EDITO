/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The tool reference promises `cutroom` commands by name. The CLI has no
// fallback for a tool it doesn't wrap, so a command the docs name and
// apps/cli doesn't register fails as unknown; these checks keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const commands = new Set([...read('apps', 'cli', 'src', 'index.ts').matchAll(/\.(?:command|alias)\(\s*["']([a-z_]+)/g)].map(([, name]) => name));
const toolDir = join(root, 'packages', 'dapi', 'src', 'tools');
const tools = readdirSync(toolDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .flatMap((file) => [...readFileSync(join(toolDir, file), 'utf8').matchAll(/^\s*name: ["']([a-z_]+)["'],/gm)].map(([, name]) => name));

const readme = read('docs', 'reference', 'tools', 'README.md');
const cliLine = readme.split('\n').find((line) => line.startsWith('- **CLI.**')) ?? '';
/** The tool table's rows: the tools each row links and its CLI cell. */
const rows = [...readme.slice(readme.indexOf('## The tools')).matchAll(/^\| (\[[^|]+\]\([^)]+\)) \| ([^|]+) \|/gm)].map(([, names, cell]) => ({
  tools: [...names.matchAll(/`([a-z_]+)`/g)].map(([, name]) => name),
  cell: cell.trim(),
}));
/** Whether the CLI paragraph names `tool` as MCP-only, by name or as `prefix_*`. */
const namedMcpOnly = (tool) => cliLine.includes(`\`${tool}\``)
  || [...cliLine.matchAll(/`([a-z_]+)_\*`/g)].some(([, prefix]) => tool.startsWith(`${prefix}_`));

/** Every Markdown page under `dir`, as absolute paths. */
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

test('the CLI commands and the tool catalog are both read', () => {
  for (const name of ['open', 'media_download', 'audio_catalog', 'instagram_posts']) assert.ok(commands.has(name), name);
  assert.ok(tools.length >= 40, `${tools.length} tools`);
  assert.ok(tools.includes('footage_cut') && tools.includes('visual_status'));
  assert.ok(cliLine, 'the README has a CLI paragraph');
});

test('the tool table lists every tool, with a CLI command only where the CLI has one', () => {
  const listed = rows.flatMap((row) => row.tools);
  for (const tool of tools) assert.ok(listed.includes(tool), `${tool} is missing from the tool table`);
  for (const row of rows) {
    if (row.cell === '—') {
      for (const tool of row.tools) {
        assert.ok(!commands.has(tool), `${tool} has a CLI command; name it in the table`);
        assert.ok(namedMcpOnly(tool), `${tool} is marked — but not named MCP-only in the CLI paragraph`);
      }
      continue;
    }
    const command = /^`cutroom ([a-z_]+)`$/.exec(row.cell)?.[1];
    assert.ok(command, `unexpected CLI cell ${row.cell}`);
    assert.ok(row.tools.includes(command), `${row.cell} is not one of ${row.tools.join(', ')}`);
    for (const tool of row.tools) assert.ok(commands.has(tool), `cutroom ${tool} isn't a CLI command; mark the row —`);
  }
});

test('the CLI paragraph names no tool the CLI wraps as MCP-only', () => {
  for (const tool of tools) if (commands.has(tool)) assert.ok(!namedMcpOnly(tool), tool);
});

test('the docs show only cutroom commands the CLI registers', () => {
  for (const page of pages(docs)) {
    const text = readFileSync(page, 'utf8');
    // Inline code (`cutroom grab …`) and code-block lines that start with a command.
    for (const [, name] of text.matchAll(/(?:`|^)cutroom ([a-z_]+)/gm)) {
      assert.ok(commands.has(name), `${page.slice(docs.length + 1)} shows \`cutroom ${name}\`, which the CLI doesn't have`);
    }
  }
});
