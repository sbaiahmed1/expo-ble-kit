#!/usr/bin/env node
// Before 1.0, versions go to npm's `next` tag only (plan §9). npm 11 ignores `publishConfig.tag`,
// so `npm publish` must get `--tag next`; this check (prepublishOnly) refuses anything else.
const { version } = require('../package.json');

const tag = process.env.npm_config_tag;
if (Number(version.split('.')[0]) < 1 && tag !== 'next') {
  console.error(
    `Refusing to publish ${version} with tag "${tag ?? 'latest'}": before 1.0, run npm publish --tag next.`
  );
  process.exit(1);
}
