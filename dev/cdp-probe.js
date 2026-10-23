// Focuses the font search in the live reader and reports viewport/scroll state.
const targets = await (await fetch('http://localhost:9222/json')).json();
const target = targets.find((t) => t.url && t.url.includes('read.libbyshelf.com'))
  || targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const expr = `(function () {
  var s = document.getElementById('morphe-font-search');
  if (!s) return 'no search';
  s.blur();
  s.focus();
  var r = s.getBoundingClientRect();
  var sc = document.querySelector('.shibui-shade-scroller');
  return JSON.stringify({
    active: document.activeElement && document.activeElement.id,
    vv: visualViewport ? { h: visualViewport.height, top: visualViewport.offsetTop } : null,
    inner: innerHeight,
    rect: { top: r.top, bottom: r.bottom },
    scroller: sc ? { st: sc.scrollTop, sh: sc.scrollHeight, ch: sc.clientHeight } : null
  });
})()`;
await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
await new Promise((resolve) => setTimeout(resolve, 1200));

const result = await send('Runtime.evaluate', {
  expression: `(function () {
    var s = document.getElementById('morphe-font-search');
    var r = s.getBoundingClientRect();
    var sc = document.querySelector('.shibui-shade-scroller');
    return JSON.stringify({
      active: document.activeElement && document.activeElement.id,
      vv: visualViewport ? { h: visualViewport.height, top: visualViewport.offsetTop } : null,
      inner: innerHeight,
      rect: { top: r.top, bottom: r.bottom },
      scroller: sc ? { st: sc.scrollTop, sh: sc.scrollHeight, ch: sc.clientHeight } : null
    });
  })()`,
  returnByValue: true,
});
console.log(result.result.result.value);
ws.close();
