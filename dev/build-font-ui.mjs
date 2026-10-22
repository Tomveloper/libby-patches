import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(root, 'extensions/font/src/main/font-ui');
const outDir = join(root, 'dev/dist');

const js = await readFile(join(uiDir, 'controller.js'), 'utf8');

// HTML and CSS are supplied by FontBridge.getHtml()/getCss() on the device.
// Keeping them out of this bundle avoids embedding markup in a JS file.
const bundle = `(function () {
if (window.MorpheFont) { return; }
${js}
})();`;

const fallbackCss =
  'body,p,div,span,li,a,h1,h2,h3,h4,h5,h6,blockquote,td,th{font-family:monospace !important}';

// The dev injection has no native bridge, so it seeds a fake library to exercise
// the list, search, and delete confirmation. Entries have no URL, so selecting
// one keeps the fallback CSS; deleting needs the real bridge.
const devLibrary = JSON.stringify({
  enabled: true,
  selected: 'dev-1',
  fonts: [
    { id: 'dev-1', name: 'Dev monospace test', format: 'woff2', size: 184320, url: '' },
    { id: 'dev-2', name: 'Literata', format: 'otf', size: 2293760, url: '' },
    { id: 'dev-3', name: 'OpenDyslexic', format: 'ttf', size: 460800, url: '' }
  ]
});

const init = `${bundle}
(function () {
  var frame = document.querySelector('iframe');
  var doc = frame && frame.contentDocument;
  var existing = doc && doc.getElementById('morphe-font-dynamic');
  var css = existing ? existing.textContent : ${JSON.stringify(fallbackCss)};
  if (existing) existing.disabled = true;
  // Dev injection bypasses the native bridge, so use the fallback CSS and
  // pretend a font is selected. The real extension uses the uploaded library.
  window.MorpheFont.init(css, true, 'Dev monospace test', true, ${JSON.stringify(devLibrary)});
})();`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'font-ui.js'), bundle, 'utf8');
await writeFile(join(outDir, 'inject.js'), init, 'utf8');
console.log('Wrote dev/dist/font-ui.js and dev/dist/inject.js');
