# Font UI development

The UI is split into three source files:

```
extensions/font/src/main/font-ui/
  section.html     markup
  section.css      styles
  controller.js    behavior
```

They are **not** fetched at runtime. The Gradle build embeds `controller.js` as
`FontUiData.JS`; the native bridge serves the HTML and CSS from `FontUiData`.
The WebView still evaluates one script.

## Build the dev bundle

```powershell
node dev/build-font-ui.mjs
```

This writes:

- `dev/dist/font-ui.js` - the UI bundle (defines `window.MorpheFont`)
- `dev/dist/inject.js` - the bundle plus a test init call

`dev/dist/` is generated and ignored by Git. Run the command after changing
`controller.js`.

## Test in the reader

### Manual

Open the reader, open DevTools, and paste the contents of
`dev/dist/inject.js` into the console.

### Automatic

With the phone connected (`adb devices` must list it), the reader open, and the
debug patch installed:

```powershell
node dev/inject-font-ui.mjs
```

The script forwards the WebView debug socket, finds the `read.libbyshelf.com`
page, and runs `dev/dist/inject.js` over the DevTools protocol.

Dev injection bypasses the native bridge, so it uses a monospace fallback style
and treats it as the selected font. The real extension uses the font you upload
in **Custom Font Settings**.

## Runtime build

`extensions/font/build.gradle.kts` generates `FontUiData.java` from the same
three files. `FontHook` evaluates `FontUiData.JS` and calls:

```text
MorpheFont.init(css, enabled, name, hasFont)
```

No `fetch()`, no asset lookup, and no extra runtime request is involved.
