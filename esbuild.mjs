import esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  // pg-native is optional; cloudflare:sockets is only used on Workers
  external: [
    'vscode',
    'pg-native',
    'cloudflare:sockets',
    // optional mongodb driver deps (Kerberos, compression, AWS/GCP auth, encryption) — not used
    'kerberos',
    '@mongodb-js/zstd',
    '@aws-sdk/credential-providers',
    'gcp-metadata',
    'snappy',
    'socks',
    'aws4',
    'mongodb-client-encryption',
  ],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const webview = {
  entryPoints: ['webview/grid.ts', 'webview/import.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outdir: 'dist/webview',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

function copyAssets() {
  fs.mkdirSync('dist/webview', { recursive: true });
  fs.copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
  fs.copyFileSync('webview/grid.css', 'dist/webview/grid.css');
}

copyAssets();
if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
  fs.watch('webview/grid.css', copyAssets);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
