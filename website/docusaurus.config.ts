import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

// The guides stay in the repository's docs/ folder, which the README links to as well; the site
// reads them in place. The API reference is generated from the package's entry points into api/
// (gitignored), and the changelog page from CHANGELOG.md and the pending changesets.

const repo = 'https://github.com/sbaiahmed1/expo-ble-kit';
// Served by GitHub Pages (.github/workflows/website.yml). SITE_URL and BASE_URL override the
// origin and the path, for example to serve a fork's build elsewhere.
const baseUrl = process.env.BASE_URL ?? '/expo-ble-kit/';

const config: Config = {
  title: 'expo-ble-kit',
  tagline: 'Bluetooth Low Energy for Expo and React Native',
  favicon: 'img/favicon.svg',

  url: process.env.SITE_URL ?? 'https://sbaiahmed1.github.io',
  baseUrl,
  organizationName: 'sbaiahmed1',
  projectName: 'expo-ble-kit',
  // GitHub Pages serves page.html at /page: links without a trailing slash avoid its redirects.
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {
    // The guides are plain Markdown (also read on GitHub and by TypeDoc): no MDX for .md files.
    format: 'detect',
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },

  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          include: [
            'getting-started.md',
            'guides/*.md',
            'troubleshooting.md',
            'compatibility.md',
            'benchmarks.md',
            'soak.md',
          ],
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: ({ docPath }) => `${repo}/edit/main/docs/${docPath}`,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        id: 'api',
        entryPoints: ['../src/index.ts', '../src/testing/index.ts', '../src/compat/plx/index.ts'],
        tsconfig: '../tsconfig.json',
        out: 'api',
        docsPath: './api',
        readme: 'none',
        excludePrivate: true,
        excludeProtected: true,
        excludeInternal: true,
        sort: ['source-order'],
        disableGit: true,
        gitRevision: 'main',
        // Without git, {path} is relative to src/, where the entry points live.
        sourceLinkTemplate: `${repo}/blob/{gitRevision}/src/{path}#L{line}`,
        // One entry per module (expo-ble-kit, expo-ble-kit/testing, expo-ble-kit/compat/plx), not
        // folders split at each "/".
        navigation: { includeFolders: false, includeGroups: true, includeCategories: false },
        parametersFormat: 'table',
        enumMembersFormat: 'table',
        useCodeBlocks: true,
        sidebar: { pretty: true },
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'api',
        path: 'api',
        routeBasePath: 'api',
        sidebarPath: './sidebarsApi.ts',
      },
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        indexPages: true,
        docsRouteBasePath: ['docs', 'api'],
        docsDir: ['../docs', 'api'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    announcementBar: {
      id: 'preview',
      content: `Preview: these docs follow the <code>main</code> branch, ahead of the latest npm release. See the <a href="${baseUrl}changelog">changelog</a> for what has shipped.`,
      isCloseable: true,
    },
    docs: { sidebar: { hideable: true } },
    navbar: {
      title: 'expo-ble-kit',
      logo: { alt: '', src: 'img/logo.svg' },
      hideOnScroll: false,
      items: [
        { type: 'docSidebar', sidebarId: 'guides', label: 'Docs', position: 'left' },
        {
          type: 'docSidebar',
          sidebarId: 'api',
          docsPluginId: 'api',
          label: 'API',
          position: 'left',
        },
        { to: '/changelog', label: 'Changelog', position: 'left' },
        { href: 'https://www.npmjs.com/package/expo-ble-kit', label: 'npm', position: 'right' },
        { href: repo, label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting started', to: '/docs/getting-started' },
            { label: 'Permissions', to: '/docs/guides/permissions' },
            { label: 'Troubleshooting', to: '/docs/troubleshooting' },
          ],
        },
        {
          title: 'Reference',
          items: [
            { label: 'API', to: '/api' },
            { label: 'Changelog', to: '/changelog' },
            { label: 'Benchmarks', to: '/docs/benchmarks' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: repo },
            { label: 'npm', href: 'https://www.npmjs.com/package/expo-ble-kit' },
          ],
        },
      ],
      copyright: `MIT License · © ${new Date().getFullYear()} Ahmed Sbai`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'json', 'diff'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
