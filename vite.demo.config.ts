import { mergeConfig, type Plugin } from 'vite';
import repositoryConfig from './vite.config';

// Website demo: the real renderer on the offline fake provider (open with ?provider=fake, add &autoplay to start playing).
process.env.YAQMC_QA_BUILD = '1';

const demoEntry: Plugin = {
  name: 'yaqmc-demo-entry',
  enforce: 'pre',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) => html.replace('/src/main.tsx', '/src/development/website-demo.tsx'),
  },
  // Fixture artwork uses root paths; make them relative so the demo works under /YAQMC/demo/.
  transform: (code, id) =>
    id.includes('/src/') && code.includes('/artwork/')
      ? code.replace(/(['"`])\/artwork\//g, '$1./artwork/')
      : null,
};

export default mergeConfig(repositoryConfig({ command: 'build', mode: 'production' }), {
  plugins: [demoEntry],
  publicDir: 'public',
  build: { outDir: 'dist/pages/demo', emptyOutDir: true },
});
