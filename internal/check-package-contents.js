#!/usr/bin/env node
// Fails if the npm package would ship files that belong only to the repository: tests, fakes,
// build caches, docs, the example app, test peripherals or e2e tooling. npm reads .npmignore,
// not .gitignore, so gitignored folders can leak into the package without this check. Also fails
// if a file the package's entry points name (main, types, exports, typesVersions) is missing.
const { execFileSync } = require('child_process');

const pkg = require('../package.json');

const FORBIDDEN = [
  /(^|\/)\.build\//,
  /(^|\/)\.swiftpm\//,
  /^ios\/Tests\//,
  /^ios\/Package\.swift$/,
  /^android\/src\/(test|androidTest)\//,
  /^android\/build\//,
  /^(docs|example|e2e|test-peripherals|test-contracts|internal|benchmarks)\//,
  /(^|\/)__tests__\//,
];
// Every packed file must be one of these: the build, its sources, the native code, the plugin, and
// the agent skill (skills/<name>/SKILL.md, which `npx @expo/agent-cli skills:sync` links, P6-03).
// A file anywhere else fails the check, so nothing new reaches the package unnoticed.
const ALLOWED = [
  /^build\//,
  /^src\//,
  /^plugin\/(build|src)\//,
  /^ios\/(Core|Binding)\//,
  /^ios\/ExpoBleKit\.podspec$/,
  /^android\/src\/main\//,
  /^android\/(build\.gradle|consumer-rules\.pro)$/,
  /^skills\/[A-Za-z0-9._-]+\/(SKILL\.md|references\/[A-Za-z0-9._-]+\.md)$/,
  /^(app\.plugin\.js|expo-module\.config\.json|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
];
// A backstop for a whole folder leaking in under an allowed path.
const MAX_FILES = 400;

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const files = JSON.parse(output)[0].files.map((file) => file.path);
const leaked = files.filter(
  (path) =>
    FORBIDDEN.some((pattern) => pattern.test(path)) ||
    !ALLOWED.some((pattern) => pattern.test(path))
);

/** Every file path named in a field of package.json, without the leading "./". */
function entryFiles(value) {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  if (Array.isArray(value)) return value.flatMap(entryFiles);
  if (value && typeof value === 'object') return Object.values(value).flatMap(entryFiles);
  return [];
}
const missing = [
  ...new Set([pkg.main, pkg.types, pkg.exports, pkg.typesVersions].flatMap(entryFiles)),
].filter((path) => !files.includes(path));

if (missing.length > 0) {
  console.error('npm package check failed: entry points name files the package lacks.');
  for (const path of missing) console.error(`  missing: ${path} (run yarn prepare?)`);
  process.exit(1);
}

if (leaked.length > 0 || files.length > MAX_FILES) {
  console.error(`npm package check failed (${files.length} files, limit ${MAX_FILES}).`);
  for (const path of leaked.slice(0, 20)) console.error(`  leaked: ${path}`);
  if (leaked.length > 20) console.error(`  ...and ${leaked.length - 20} more`);
  console.error('Add the paths to .npmignore.');
  process.exit(1);
}
console.log(`npm package check passed: ${files.length} files.`);
