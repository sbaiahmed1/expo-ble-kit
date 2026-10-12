// Writes src/pages/changelog.md from the repository's CHANGELOG.md, with the pending changesets
// (.changeset/*.md) first, as what the next release brings.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const kinds = { major: 'Major changes', minor: 'Minor changes', patch: 'Patch changes' };

const pending = { major: [], minor: [], patch: [] };
const changesets = join(root, '.changeset');
for (const file of readdirSync(changesets).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
  const text = readFileSync(join(changesets, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) continue;
  const kind = /: *['"]?(major|minor|patch)/.exec(match[1])?.[1] ?? 'patch';
  pending[kind].push(match[2].trim());
}

const released = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/^# .*\n/, '');
const unreleased = Object.entries(kinds)
  .filter(([kind]) => pending[kind].length > 0)
  .map(([kind, title]) => {
    const entries = pending[kind].map((entry) => `- ${entry.replace(/\n/g, '\n  ')}`);
    return `### ${title}\n\n${entries.join('\n')}`;
  })
  .join('\n\n');

const frontMatter = [
  '---',
  'title: Changelog',
  'description: What changed in each expo-ble-kit release, and what the next one brings.',
  '---',
].join('\n');
const next =
  unreleased && `## Next release\n\nOn the \`main\` branch, not on npm yet.\n\n${unreleased}`;
const page = [frontMatter, '# Changelog', next, released.trim()].filter(Boolean).join('\n\n');

writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'changelog.md'),
  `${page}\n`
);
