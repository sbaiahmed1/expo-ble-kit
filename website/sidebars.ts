import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Ids are the paths of the guides in the repository's docs/ folder.
const sidebars: SidebarsConfig = {
  guides: [
    'getting-started',
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: [
        'guides/permissions',
        'guides/bare-setup',
        'guides/accessory-setup',
        'guides/migration-from-plx',
      ],
    },
    'troubleshooting',
    {
      type: 'category',
      label: 'Quality',
      items: ['benchmarks', 'soak'],
    },
  ],
};

export default sidebars;
