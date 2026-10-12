import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// docusaurus-plugin-typedoc writes this sidebar next to the pages it generates: one category per
// module, shown here main entry first.
import typedocSidebar from './api/typedoc-sidebar.cjs';

const order = ['expo-ble-kit', 'expo-ble-kit/testing', 'expo-ble-kit/compat/plx'];
const rank = (item: { label?: string }) => {
  const index = order.indexOf(item.label ?? '');
  return index === -1 ? order.length : index;
};

const sidebars: SidebarsConfig = {
  api: [
    { type: 'doc', id: 'index', label: 'Overview' },
    ...[...typedocSidebar].sort((a, b) => rank(a) - rank(b)),
  ],
};

export default sidebars;
