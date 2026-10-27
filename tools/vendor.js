// Rebuilds the browser files in public/vendor from node_modules (npm install first).
// The Activity can't load scripts from other sites (Discord's content security policy),
// so the Discord SDK and hls.js are shipped with the app.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/vendor', { recursive: true });
await build({
  stdin: { contents: "export { DiscordSDK } from '@discord/embedded-app-sdk';", resolveDir: '.' },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  outfile: 'public/vendor/discord-sdk.js',
  legalComments: 'none',
});
copyFileSync('node_modules/hls.js/dist/hls.light.min.js', 'public/vendor/hls.min.js');
console.log('public/vendor updated');
