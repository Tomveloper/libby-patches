(function () {
  'use strict';

  var SECTION_ID = 'morphe-font-settings';
  var SECTION_FLAG = 'data-morphe-font-ui';
  var ROOT_FLAG = 'data-morphe-font-root';
  var ROOT_SELECTOR = 'html[' + ROOT_FLAG + '][' + ROOT_FLAG + '][' + ROOT_FLAG + ']';
  var FONT_RULE = ROOT_SELECTOR + ',' +
    ROOT_SELECTOR + ' body,' +
    ROOT_SELECTOR + ' body *{' +
    'font-family:MorpheFont,serif !important}';
  var fontCss = '';
  var enabled = false;
  var hasFont = false;
  var fontName = '';
  var statusText = 'No font selected';
  var fonts = [];
  var selectedId = '';
  var searchQuery = '';
  var pendingDelete = '';
  var eventsWired = false;
  var injectScheduled = false;

  function topDocument() {
    try {
      return window.top.document;
    } catch (e) {
      return document;
    }
  }

  function bridge() {
    return window.MorpheFontBridge || null;
  }

  function uiHtml() {
    try {
      var b = bridge();
      if (b && typeof b.getHtml === 'function') {
        return b.getHtml();
      }
    } catch (e) {
      // Fall through to the development fallback.
    }
    return window.MORPHE_FONT_HTML || '';
  }

  function uiCss() {
    try {
      var b = bridge();
      if (b && typeof b.getCss === 'function') {
        return b.getCss();
      }
    } catch (e) {
      // Fall through to the development fallback.
    }
    return window.MORPHE_FONT_CSS || '';
  }

  function applyTo(doc) {
    if (!doc || !doc.head) {
      return;
    }
    if (doc.documentElement) {
      doc.documentElement.setAttribute(ROOT_FLAG, '1');
    }
    var style = doc.getElementById('morphe-font-dynamic');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'morphe-font-dynamic';
      doc.head.appendChild(style);
    }
    var next = enabled && hasFont ? fontCss : '';
    if (style.textContent !== next) {
      style.textContent = next;
    }
  }

  function apply() {
    var doc = topDocument();
    var frames = doc.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var child = null;
      try {
        child = frames[i].contentDocument;
      } catch (e) {
        // Cross-origin iframe; ignore it.
      }
      if (child) {
        applyTo(child);
      }
    }
  }

  function onFrameLoad(event) {
    var target = event.target;
    if (!target || target.tagName !== 'IFRAME') {
      return;
    }
    var child = null;
    try {
      child = target.contentDocument;
    } catch (e) {
      // Cross-origin iframe; ignore it.
    }
    if (child) {
      applyTo(child);
    }
  }

  function isAppearanceButton(button) {
    var label = button && button.querySelector('.nav-action-item-label');
    return !!label && label.textContent.trim() === 'Appearance';
  }

  // Libby stops the Appearance click before it bubbles, so use the capture
  // phase. The dialog is created after the event, so defer one task instead of
  // polling. Multiple taps collapse into one pending injection.
  function scheduleInject() {
    if (injectScheduled) {
      return;
    }
    injectScheduled = true;
    setTimeout(function () {
      injectScheduled = false;
      inject();
    }, 0);
  }

  // The shibui switch is initialized by the reader's own JS. Our copy is created
  // later, so it misses the halo/background that the original switch gets at
  // startup. Copy the visible knob color from a real, checked switch.
  function copyKnobStyle(doc, helper) {
    var offFace = doc.querySelector(
      '.shibui-form-switch-control:not(:checked) + .shibui-form-switch-face'
    );
    var onFace = doc.querySelector(
      '.shibui-form-switch-control:checked + .shibui-form-switch-face'
    );

    var bg = null;
    var img = null;

    [offFace, onFace].forEach(function (face) {
      if (!face) {
        return;
      }
      var computed = getComputedStyle(face);
      if (!bg && computed.backgroundColor &&
          computed.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          computed.backgroundColor !== 'transparent') {
        bg = computed.backgroundColor;
      }
      if (!img && computed.backgroundImage && computed.backgroundImage !== 'none') {
        img = computed.backgroundImage;
      }
    });

    if (bg) {
      helper.textContent += '\n#' + SECTION_ID +
        ' #morphe-font-enabled:not(:checked) + .shibui-form-switch-face{' +
        'background-color:' + bg + ' !important;}';
    }

    if (img) {
      helper.textContent += '\n#' + SECTION_ID +
        ' #morphe-font-enabled:not(:checked) + .shibui-form-switch-face{' +
        'background-image:' + img + ' !important;}';
    }
  }

  function refreshHelper(doc) {
    var helper = doc.getElementById('morphe-font-helper-style');
    if (!helper) {
      return;
    }
    helper.textContent = uiCss();
    copyKnobStyle(doc, helper);
  }

  function baseStatus() {
    return hasFont ? (fontName || 'Custom font') : 'No font selected';
  }

  function setStatus(section, text) {
    statusText = text || '';
    var el = section && section.querySelector('#morphe-font-status');
    // Only write when the value changes; repeated writes cause needless DOM work.
    if (el && el.textContent !== statusText) {
      el.textContent = statusText;
    }
  }

  function setSwitch(section, value) {
    var toggle = section && section.querySelector('#morphe-font-enabled');
    if (!toggle) {
      return;
    }
    if (toggle.checked !== !!value) {
      toggle.checked = !!value;
    }
    if (toggle.disabled !== !hasFont) {
      toggle.disabled = !hasFont;
    }
  }

  function cssFormat(format) {
    return format === 'ttf' ? 'truetype'
      : format === 'otf' ? 'opentype' : format;
  }

  function fontCssFromUrl(url, format) {
    return "@font-face{font-family:MorpheFont;src:url(" + url + ")" +
      " format('" + cssFormat(format) + "');" +
      "font-weight:400;font-style:normal}" + FONT_RULE;
  }

  function parseState(json) {
    if (!json) {
      return null;
    }
    try {
      var state = typeof json === 'string' ? JSON.parse(json) : json;
      return state && typeof state === 'object' ? state : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeFonts(list) {
    var out = [];
    if (!list || !list.length) {
      return out;
    }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.id) {
        continue;
      }
      out.push({
        id: String(item.id),
        name: String(item.name || 'Custom font'),
        format: String(item.format || ''),
        size: typeof item.size === 'number' ? item.size : 0,
        url: String(item.url || '')
      });
    }
    return out;
  }

  function findFont(id) {
    if (!id) {
      return null;
    }
    for (var i = 0; i < fonts.length; i++) {
      if (fonts[i].id === id) {
        return fonts[i];
      }
    }
    return null;
  }

  // Replaces the whole UI state from one bridge payload. Called on init, after
  // an upload, and after selecting or deleting a font.
  function applyState(state) {
    if (!state) {
      return false;
    }
    fonts = normalizeFonts(state.fonts);
    selectedId = state.selected ? String(state.selected) : '';

    var selected = findFont(selectedId);
    if (!selected) {
      selectedId = '';
    }
    hasFont = !!selected;
    enabled = hasFont && !!state.enabled;
    fontName = selected ? selected.name : '';
    // A font without a URL only happens in the console-based dev injection;
    // keep the CSS it was started with.
    if (selected && selected.url) {
      fontCss = fontCssFromUrl(selected.url, selected.format);
    } else if (!selected) {
      fontCss = '';
    }
    statusText = baseStatus();
    return true;
  }

  function formatSize(bytes) {
    var units = ['B', 'KB', 'MB', 'GB'];
    var value = bytes;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value = value / 1024;
      unit++;
    }
    return (unit === 0 ? String(Math.round(value)) : value.toFixed(1)) +
      ' ' + units[unit];
  }

  function metaFor(font) {
    var parts = [];
    if (font.format) {
      parts.push(font.format.toUpperCase());
    }
    if (font.size > 0) {
      parts.push(formatSize(font.size));
    }
    return parts.join(' \u00b7 ');
  }

  function visibleFonts() {
    var query = searchQuery.toLowerCase();
    if (!query) {
      return fonts;
    }
    var out = [];
    for (var i = 0; i < fonts.length; i++) {
      if (fonts[i].name.toLowerCase().indexOf(query) >= 0) {
        out.push(fonts[i]);
      }
    }
    return out;
  }

  function choiceRow(doc, font) {
    var row = doc.createElement('div');
    row.className = 'morphe-font-row' + (font.id === selectedId ? ' is-selected' : '');

    var choice = doc.createElement('button');
    choice.type = 'button';
    choice.className = 'morphe-font-choice';
    choice.setAttribute('data-font-select', font.id);
    choice.setAttribute('aria-pressed', font.id === selectedId ? 'true' : 'false');

    var name = doc.createElement('span');
    name.className = 'morphe-font-choice-name';
    name.textContent = font.name;

    var meta = doc.createElement('span');
    meta.className = 'morphe-font-choice-meta';
    meta.textContent = metaFor(font);

    choice.appendChild(name);
    choice.appendChild(meta);

    var remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'morphe-font-delete';
    remove.setAttribute('data-font-delete', font.id);
    remove.setAttribute('aria-label', 'Delete ' + font.name);
    remove.textContent = 'Delete';

    row.appendChild(choice);
    row.appendChild(remove);
    return row;
  }

  // Libby's WebChromeClient cannot be relied on to show window.confirm(), so the
  // confirmation replaces the row itself. No overlay and no blocking dialog.
  function confirmRow(doc, font) {
    var row = doc.createElement('div');
    row.className = 'morphe-font-row is-confirming';

    var text = doc.createElement('span');
    text.className = 'morphe-font-confirm-text';
    text.textContent = font.id === selectedId
      ? 'Delete "' + font.name + '"? The custom font turns off and the app font returns.'
      : 'Delete "' + font.name + '"?';

    var yes = doc.createElement('button');
    yes.type = 'button';
    yes.className = 'morphe-font-confirm';
    yes.setAttribute('data-font-delete-confirm', font.id);
    yes.textContent = 'Delete';

    var no = doc.createElement('button');
    no.type = 'button';
    no.className = 'morphe-font-cancel';
    no.setAttribute('data-font-delete-cancel', '1');
    no.textContent = 'Cancel';

    row.appendChild(text);
    row.appendChild(yes);
    row.appendChild(no);
    return row;
  }

  function renderList(section) {
    if (!section) {
      return;
    }
    var list = section.querySelector('#morphe-font-list');
    if (!list) {
      return;
    }
    var search = section.querySelector('#morphe-font-search');
    var empty = section.querySelector('#morphe-font-empty');

    // A search box is only useful with more than one font. Clear the query when
    // the library shrinks so the list cannot stay filtered by a hidden box.
    if (fonts.length <= 1) {
      searchQuery = '';
    }
    if (search) {
      if (search.value !== searchQuery) {
        search.value = searchQuery;
      }
      if (search.hidden !== (fonts.length <= 1)) {
        search.hidden = fonts.length <= 1;
      }
    }

    var items = visibleFonts();
    var signature = [fonts.length, selectedId, pendingDelete, searchQuery]
      .join('\u0001');
    for (var i = 0; i < items.length; i++) {
      var font = items[i];
      signature += '\u0002' + font.id + '\u0001' + font.name + '\u0001' +
        font.format + '\u0001' + font.size;
    }

    // Rebuild only when something visible changed. The signature lives on the
    // list element, so a freshly injected section always renders.
    if (list.getAttribute('data-morphe-font-signature') !== signature) {
      var doc = section.ownerDocument;
      var frag = doc.createDocumentFragment();
      for (var j = 0; j < items.length; j++) {
        frag.appendChild(items[j].id === pendingDelete
          ? confirmRow(doc, items[j])
          : choiceRow(doc, items[j]));
      }
      list.textContent = '';
      list.appendChild(frag);
      list.setAttribute('data-morphe-font-signature', signature);
    }

    if (empty) {
      var text = !fonts.length
        ? 'No fonts uploaded yet.'
        : (items.length ? '' : 'No font matches "' + searchQuery + '".');
      if (empty.textContent !== text) {
        empty.textContent = text;
      }
      if (empty.hidden !== !text) {
        empty.hidden = !text;
      }
    }
  }

  function syncSection() {
    var section = topDocument().getElementById(SECTION_ID);
    if (section) {
      setSwitch(section, enabled);
      setStatus(section, statusText);
      renderList(section);
    }
    apply();
  }

  function pickFont() {
    var section = topDocument().getElementById(SECTION_ID);
    try {
      var b = bridge();
      if (b && typeof b.pickFont === 'function') {
        b.pickFont();
      } else if (section) {
        setStatus(section, 'Native picker unavailable');
      }
    } catch (e) {
      if (section) {
        setStatus(section, 'Could not open the file picker: ' + e);
      }
    }
  }

  function chooseFont(id) {
    if (!id || (id === selectedId && enabled)) {
      return;
    }
    var section = topDocument().getElementById(SECTION_ID);
    var state = null;
    try {
      var b = bridge();
      if (b && typeof b.selectFont === 'function') {
        state = parseState(b.selectFont(id));
      }
    } catch (e) {
      state = null;
    }
    if (!state || !applyState(state)) {
      setStatus(section, 'Could not select the font');
      return;
    }
    pendingDelete = '';
    syncSection();
  }

  function removeFont(id) {
    var section = topDocument().getElementById(SECTION_ID);
    var state = null;
    try {
      var b = bridge();
      if (b && typeof b.deleteFont === 'function') {
        state = parseState(b.deleteFont(id));
      }
    } catch (e) {
      state = null;
    }
    pendingDelete = '';
    if (!state || !applyState(state)) {
      setStatus(section, 'Could not delete the font');
      renderList(section);
      return;
    }
    syncSection();
  }

  function onDocumentClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest('#morphe-font-upload')) {
      pickFont();
      return;
    }

    var choose = target.closest('[data-font-select]');
    if (choose) {
      chooseFont(choose.getAttribute('data-font-select'));
      return;
    }

    var askDelete = target.closest('[data-font-delete]');
    if (askDelete) {
      pendingDelete = askDelete.getAttribute('data-font-delete');
      renderList(topDocument().getElementById(SECTION_ID));
      return;
    }

    var confirmDelete = target.closest('[data-font-delete-confirm]');
    if (confirmDelete) {
      removeFont(confirmDelete.getAttribute('data-font-delete-confirm'));
      return;
    }

    if (target.closest('[data-font-delete-cancel]')) {
      pendingDelete = '';
      renderList(topDocument().getElementById(SECTION_ID));
      return;
    }

    var button = target.closest('button.nav-action-item-button.halo');
    if (button && isAppearanceButton(button)) {
      scheduleInject();
    }
  }

  function onDocumentChange(event) {
    var target = event.target;
    if (!target) {
      return;
    }
    if (target.id === 'morphe-font-enabled') {
      enabled = hasFont && !!target.checked;
      try {
        var b = bridge();
        if (b && typeof b.setEnabled === 'function') {
          b.setEnabled(enabled);
        }
      } catch (e) {
        // Keep the UI responsive even if the bridge call fails.
      }
      apply();
    }
  }

  function onDocumentInput(event) {
    var target = event.target;
    if (target && target.id === 'morphe-font-search') {
      searchQuery = (target.value || '').trim();
      renderList(topDocument().getElementById(SECTION_ID));
    }
  }

  function wireEvents(doc) {
    if (eventsWired) {
      return;
    }
    eventsWired = true;
    // Capture phase: Libby stops some clicks before they bubble, but capture
    // still sees them. Delegation also survives the dialog being re-rendered.
    doc.addEventListener('click', onDocumentClick, true);
    doc.addEventListener('change', onDocumentChange, true);
    doc.addEventListener('input', onDocumentInput, true);
    // load does not bubble, but the capture phase still reaches the document.
    doc.addEventListener('load', onFrameLoad, true);
  }

  function inject() {
    var doc = topDocument();
    var host = doc.querySelector('.readability-dialog-sections');
    if (!host) {
      return;
    }

    var section = host.querySelector('[' + SECTION_FLAG + ']');
    var created = false;

    if (!section) {
      var html = uiHtml();
      if (!html) {
        return;
      }
      section = doc.createElement('div');
      section.className = 'readability-section readability-section-font';
      section.id = SECTION_ID;
      section.setAttribute(SECTION_FLAG, '1');
      section.innerHTML = html;
      host.appendChild(section);
      created = true;
    }

    var helper = doc.getElementById('morphe-font-helper-style');
    if (!helper) {
      helper = doc.createElement('style');
      helper.id = 'morphe-font-helper-style';
      doc.head.appendChild(helper);
      created = true;
    }

    if (created) {
      // The dialog is rebuilt from scratch each time it opens, so drop the
      // transient filter and confirmation with it.
      searchQuery = '';
      pendingDelete = '';
      refreshHelper(doc);
      setTimeout(function () {
        refreshHelper(doc);
      }, 300);
    }

    setSwitch(section, enabled);
    setStatus(section, statusText);
    renderList(section);
    wireEvents(doc);
  }

  window.MorpheFont = {
    init: function (css, isEnabled, name, hasFontValue, libraryJson) {
      if (typeof css === 'string') {
        fontCss = css;
      }
      hasFont = !!hasFontValue;
      enabled = hasFont && !!isEnabled;
      fontName = name || '';
      statusText = baseStatus();
      var state = parseState(libraryJson);
      if (state) {
        applyState(state);
      }
      var doc = topDocument();
      wireEvents(doc);
      inject();
      apply();
    },

    setEnabled: function (isEnabled) {
      enabled = hasFont && !!isEnabled;
      var section = topDocument().getElementById(SECTION_ID);
      if (section) {
        setSwitch(section, enabled);
      }
      apply();
    },

    // Called after an upload or by any native change to the font library.
    onLibraryChanged: function (json) {
      var state = parseState(json);
      if (!state || !applyState(state)) {
        return;
      }
      pendingDelete = '';
      syncSection();
    },

    onFontError: function (message) {
      var section = topDocument().getElementById(SECTION_ID);
      setStatus(section, message || 'Font error');
    },

    onPickCancelled: function () {
      var section = topDocument().getElementById(SECTION_ID);
      setStatus(section, baseStatus());
    },

    reload: function () {
      apply();
    }
  };
})();
