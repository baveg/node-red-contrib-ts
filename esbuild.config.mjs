import { build } from 'esbuild';
import { copyFile, cp, readFile, rm, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('./package.json', 'utf8'));

const config = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: 'dist',
  external: ['node-red', 'typescript'],
  sourcemap: false,
  minify: true,
  treeShaking: true,
  // drop: ['console', 'debugger'],
  legalComments: 'none',
  keepNames: false,
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
};

const serverConfig = {
  ...config,
  entryPoints: ["src/typescript.ts"],
};

const clientConfig = {
  ...config,
  entryPoints: ["src/typescript.html.ts"],
};

// Build
async function buildAll() {

  await build(serverConfig);
  await build(clientConfig);

  // Inject JS
  const html = await readFile('src/typescript.html');
  const js = await readFile('dist/typescript.html.js');
  const htmlInjected = String(html).replace('/** INJECT_JS **/', String(js));
  await writeFile('dist/typescript.html', htmlInjected);
  await rm('dist/typescript.html.js');
  
  await cp('src/icons', 'dist/icons', { recursive: true });

}

buildAll().catch((error) => {
  console.error(error);
  process.exit(1);
});