// Assembles index.html from src/*. Usage: node build.mjs
// The result is one self-contained file (no bundler, no dependencies) that GitHub Pages can serve as-is.
import { readFileSync, writeFileSync } from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const css = read('./src/style.css').replace(/^@import[^\n]*\n/, '');   // fonts load via <link> in head.html
const demo = process.argv.includes('--demo');          // node build.mjs --demo  ->  demo.html (sample shop, no database)
let js = ['core', 'api', 'live', 'ui'].map(n => read(`./src/${n}.js`)).join('\n');
if (demo) {
  if (!js.includes('const DEMO = false;')) { console.error('build: DEMO flag not found'); process.exit(1); }
  js = js.replace('const DEMO = false;', 'const DEMO = true;');
}

for (const bad of ['</script', '<!--']) {
  if (js.includes(bad)) { console.error(`build: "${bad}" appears inside the JavaScript and would break the page`); process.exit(1); }
}
const page = read('./src/head.html').replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
const out = demo ? 'demo.html' : 'index.html';
writeFileSync(new URL('./' + out, import.meta.url), demo ? page.replace('<script src="config.js"></script>\n', '') : page);
console.log(`${out} written (${(page.length / 1024).toFixed(0)} KB)`);
