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

  function onDocumentClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest('#morphe-font-upload')) {
      pickFont();
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

  function wireEvents(doc) {
    if (eventsWired) {
      return;
    }
    eventsWired = true;
    // Capture phase: Libby stops some clicks before they bubble, but capture
    // still sees them. Delegation also survives the dialog being re-rendered.
    doc.addEventListener('click', onDocumentClick, true);
    doc.addEventListener('change', onDocumentChange, true);
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
      refreshHelper(doc);
      setTimeout(function () {
        refreshHelper(doc);
      }, 300);
    }

    setSwitch(section, enabled);
    setStatus(section, statusText);
    wireEvents(doc);
  }

  window.MorpheFont = {
    init: function (css, isEnabled, name, hasFontValue) {
      if (typeof css === 'string') {
        fontCss = css;
      }
      hasFont = !!hasFontValue;
      enabled = hasFont && !!isEnabled;
      fontName = name || '';
      statusText = baseStatus();
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

    onFontPicked: function (name, url, format) {
      if (!url) {
        this.onFontError('Could not save the font');
        return;
      }
      fontCss = fontCssFromUrl(url, format);
      fontName = name || 'Custom font';
      hasFont = true;
      enabled = true;
      var section = topDocument().getElementById(SECTION_ID);
      if (section) {
        setSwitch(section, true);
        setStatus(section, fontName);
      } else {
        statusText = fontName;
      }
      apply();
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
