import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const injectJs = await readFile(join(root, 'dev/dist/inject.js'), 'utf8');
const pkg = 'com.overdrive.mobile.android.libby';

function adb(args, options = {}) {
  return execFileSync('adb', args, { encoding: 'utf8', ...options }).trim();
}

const devices = adb(['devices']);
if (!/^\S+\s+device$/m.test(devices)) {
  throw new Error('No adb device online. Connect the phone and accept the USB debugging prompt.');
}

const pid = adb(['shell', 'pidof', pkg]);
if (!pid) {
  throw new Error('Libby is not running. Open the app and the reader first.');
}

const socket = `webview_devtools_remote_${pid}`;

try {
  adb(['forward', '--remove', 'tcp:9222']);
} catch {
  // Nothing to remove.
}
adb(['forward', 'tcp:9222', `localabstract:${socket}`]);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const target =
  targets.find((item) => (item.url || '').includes('read.libbyshelf.com')) ||
  targets.find((item) => item.type === 'page');

if (!target || !target.webSocketDebuggerUrl) {
  throw new Error('No WebView page target found. Is the reader open and WebView debugging enabled?');
}

console.log('Injecting into:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const reply = await new Promise((resolve, reject) => {
  const id = 1;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === id) {
      resolve(message);
    }
  });
  ws.addEventListener('error', reject, { once: true });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: {
      expression: injectJs,
      awaitPromise: true,
      returnByValue: true,
    },
  }));
});

ws.close();

if (reply.result && reply.result.exceptionDetails) {
  console.error(JSON.stringify(reply.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log('Injected.');
}
