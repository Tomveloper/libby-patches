# AGENTS.md

Instructions and context for anyone (human or AI) working in this repository.

---

## 1. Purpose

This repo is based on the **Morphe patches template**. It contains a working
font patch, `Custom reading font`, which adds a reader settings section for
uploading a local font. The font is stored in the app's private storage and
served locally through a shared request router.

- Target app: `com.overdrive.mobile.android.libby` ("Libby: Read Library Books")
- Tested version: **9.5.0** (versionCode 950000)
- APK type: universal APK (not APKM/XAPK)
- Device is **not rooted**; installation is a normal user install of a re-signed APK.

---

## 2. User profile and working style

The user is learning Android patching from scratch.

**Background**

- Strong: C#, Rust, web development (HTML/CSS/JS).
- None: Kotlin, Java, smali, Android, Gradle, or Morphe before this project.

**Preferences**

- Wants **every step explained**, including what a command does and why.
  Avoid unexplained jargon; define terms the first time they appear.
- Prefers **short messages** and small, incremental steps.
- Dislikes large auto-run scripts and long unattended operations.
- Frequently declines commands to ask what they do first. **Explain before
  running**, especially anything destructive (uninstall, install, deleting files).
- Wants to be able to repeat the process independently later, not just get a
  working artifact.
- Fonts must be **stored locally** and served from app storage. No remote font
  URL and no runtime network dependency.
- The runtime patch must use **no polling**. This is a reader app, so battery use
  matters: prefer event-driven hooks (load events, delegated clicks, short-lived
  observers that disconnect themselves) and avoid recurring timers.
- Script/language coverage is not a current constraint; it depends on the font
  the user uploads.
- Font selection happens in the in-app **Custom Font Settings** section. The
  reader shows "No font selected" until one is uploaded. The picker uses
  Android's native document picker, not an HTML file input.

---

## 3. Environment (Windows)

| Item | Value |
|---|---|
| Repo | `<repo>` (this checkout) |
| Work APKs / decompiled app | `<work-dir>` |
| Stock input APK | `<work-dir>\libby-9.5.0.apk` (SHA-1 `3FDC25DA786FE17D2A9FA668E1DD978B4FB042E5`) |
| Patched output | `<work-dir>\libby-patched.apk` |
| Morphe CLI jar | `<tools>\morphe-desktop-1.19.0-all.jar` |
| JDK | JDK 21 |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk` |
| Build tools | `%LOCALAPPDATA%\Android\Sdk\build-tools\36.0.0` |
| Test device | Android phone with USB debugging enabled |
| Shell | PowerShell (`pwsh`) |

Notes:

- `java` on PATH is JDK **21** (machine PATH lists JDK 21 first). The Morphe jar
  is compiled for Java 21 (class file version 65). If a shell still resolves
  JDK 11, its environment is stale — restart the shell; do not prefix every
  command.
- `ANDROID_HOME` and `JAVA_HOME` are set at user level.
- `local.properties` contains the machine-specific `sdk.dir`. **Do not commit it.**
- Gradle credentials for the Morphe registry, if needed, come from user-level
  Gradle properties or the CI environment. **Never print or commit them.**
- Toolchain: Morphe Desktop **1.19.0** (bundles Morphe Patcher **2.0.0**), Gradle
  plugin `app.morphe.patches` **2.0.0**. This repo is based on
  `MorpheApp/morphe-patches-template`. `upstream` points at the template and
  `origin` points at your own repository, so toolchain and boilerplate updates
  (`libs.versions.toml`, `settings.gradle.kts`, `PatchListGenerator.kt`, CI
  scripts) arrive as `git merge upstream/main`. Do not hand-edit those files;
  that creates drift the next merge has to fight.

---

## 4. Repository layout

```
patches/src/main/kotlin/app/libby/patches/
  Constants.kt        compatibility metadata (package, version, icon color)
  Fingerprints.kt     how to find WebViewClient methods without hardcoding jp1
  WebRoutesPatch.kt   installs the single /morphe/ interception hook
  FontPatch.kt        injects font bridge/hook calls; depends on WebRoutesPatch
  WebViewDebugPatch.kt optional chrome://inspect support

extensions/font/
  src/main/font-ui/
    section.html                          settings section markup
    section.css                           settings section styles
    controller.js                         runtime UI and chapter styling logic
  src/main/java/app/libby/font/
    FontHook.java                         injection entry point (runs on phone)
    FontBridge.java                       picker, storage, /morphe/font route
    FontUiData.java                       generated HTML/CSS/JS constants
  src/main/java/app/libby/web/
    MorpheWebRouter.java                  /morphe/ prefix, route registry, streaming

patches/build/libs/patches-1.0.0.mpp     built patch bundle (distributable)
extensions/libby.mpe                       built extension DEX container
```

The template sample packages (`example/` and `shared/`) and the
`ExamplePatch.java` extension sample have been removed from this repo.

---

## 5. Architecture: patch vs extension

Two separate programs:

| Part | Language | Runs | Job |
|---|---|---|---|
| Patch (`patches/`) | Kotlin | On the PC, at patch time | Find a method in Libby's DEX and insert a call |
| Extension (`extensions/`) | Java | On the phone, inside Libby | Inject CSS/JS at runtime |

Two patches share the runtime:

- `WebRoutesPatch` is internal and `default = false`. It installs one
  `shouldInterceptRequest` hook and merges the extension DEX.
- `FontPatch` is the user-facing patch. It declares
  `dependsOn(webRoutesPatch)` and only inserts the font-specific calls.

`WebRoutesPatch` inserts:

```smali
invoke-static {p1, p2}, Lapp/libby/web/MorpheWebRouter;->intercept(Landroid/webkit/WebView;Landroid/webkit/WebResourceRequest;)Landroid/webkit/WebResourceResponse;
```

at instruction index `0` of
`jp1.shouldInterceptRequest(WebView, WebResourceRequest)`.

Register mapping for an instance method:

```
p0 = this
p1 = WebView
p2 = WebResourceRequest
```

The hook returns `null` for paths that do not start with `/morphe/`, so Libby's
own request handler still runs. For `/morphe/<namespace>/<path>`, the router
dispatches to the handler registered for that namespace. Unmatched routes return
a local 404; handler exceptions return a local 500.

`FontPatch` inserts:

- `FontBridge.install(WebView)` after Libby's own `addJavascriptInterface` call
  in the reader WebView constructor.
- `FontHook.onPageFinished(WebView, String)` at index `0` of
  `onPageFinished`.
- `FontBridge.onActivityResult(int, int, Intent)` at index `0` of the base
  activity's `onActivityResult`.

The extension is merged into the APK by `extendWith("extensions/libby.mpe")` in
`WebRoutesPatch`. Because `FontPatch` depends on it, Morphe applies the shared
patch once even though it is not user-selectable.

### Why the reader needs JS at all

Libby is a WebView shell:

- Outer shell: `https://libbyapp.com`
- Reader container: `https://dewey-<hash>.read.libbyshelf.com/?d=...`
- Chapter XHTML lives in a **same-origin iframe** inside the reader container.

CSS cannot cross a document boundary, so the injected JS reaches into
`iframe.contentDocument` and appends a `<style>` element there.

---

## 6. Current status

Working:

- Patch build and apply cleanly.
- `jp1.shouldInterceptRequest` verified to begin with exactly one
  `MorpheWebRouter.intercept` call.
- APK signed with the Morphe key (`CN=Morphe`), installed on device.
- **Custom Font Settings** section appears in the reader.
- Default state is "No font selected" with the toggle disabled.
- Local font upload works through a native document picker (verified).
- Uploaded font is copied atomically into private storage and streamed through
  `/morphe/font/current?v=...`; there is no fixed size limit.
- A 13.5 MB TTF was uploaded and applied successfully.
- Font choice and on/off state persist across launches.
- The custom font applies to every same-origin chapter iframe.
- The toggle survives the settings dialog being re-rendered.
- The custom font wins over Libby's OpenDyslexic book-design rule.
- Runtime behavior is event-driven: no `setInterval` and no recurring timers.

Next steps, in order of preference:

1. Optional: add a "Remove font" action that clears the stored file and returns
   the reader to the "No font selected" state.
2. Optional: add patch options only if a behavior needs to be configurable at
   patch time; font choice is already handled in-app.
3. Housekeeping: optionally slim the extension DEX (it currently carries
   ~1,100 classes) and fill in the remaining `about { ... }` metadata.

---

## 7. Commands

### Build

```powershell
cd <repo>
.\gradlew.bat buildAndroid
```

Produces `patches\build\libs\patches-1.0.0.mpp`.

### List patches (sanity check)

```powershell
java -jar <tools>\morphe-desktop-1.19.0-all.jar `
  list-patches --patches patches\build\libs\patches-1.0.0.mpp -v -p
```

Note the CLI inconsistency: `list-patches` uses `--patches`, `patch` uses `-p`.

### Apply the patch

```powershell
java -jar <tools>\morphe-desktop-1.19.0-all.jar patch `
  -p <repo>\patches\build\libs\patches-1.0.0.mpp `
  -o <work-dir>\libby-patched.apk `
  <work-dir>\libby-9.5.0.apk
```

Flags: `patch` = subcommand, `-p` = patch bundle, `-o` = output APK,
last positional = input APK. `-e`/`-d` enable/disable patches by name,
`--options-file` supplies options, `--unsigned` skips signing, `-i` installs.

### Install

```powershell
# Same signing key as the installed build: updates in place, keeps app data.
adb install -r <work-dir>\libby-patched.apk

# Only if the signing key changed (first install of a patched build, or a new key):
adb uninstall com.overdrive.mobile.android.libby   # DESTRUCTIVE: deletes app data
adb install <work-dir>\libby-patched.apk
```

Morphe re-signs with the same key (`CN=Morphe`) every build, so patched builds
update over each other with `-r`; plain `adb install` fails with
`INSTALL_FAILED_ALREADY_EXISTS`. Warn the user before uninstalling. Loans remain
on the library account; local downloads/settings do not.

After installing, disable Play Store auto-update for Libby, or Play will replace
the patched app with the signed-by-Google version.

### Verify the output (read-only)

```powershell
# signature
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs <apk>

# show the injected calls (extract classes2.dex first)
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\dexdump.exe" -d classes2.dex |
  Select-String -Pattern 'MorpheWebRouter|FontHook' -Context 2,1
```

Expected:

- `jp1.shouldInterceptRequest` starts with exactly one
  `invoke-static ..., MorpheWebRouter;.intercept(...)`.
- `jp1.onPageFinished` starts with
  `invoke-static ..., FontHook;.onPageFinished(...)V`.

The extension DEX should contain `MorpheWebRouter`, `FontBridge`, and
`FontHook`.

---

## 8. How the font is stored and served

- The reader starts in the "No font selected" state with the toggle disabled.
- Upload uses Android's native `ACTION_OPEN_DOCUMENT` picker. Libby's
  `WebChromeClient` does not implement `onShowFileChooser`, so an HTML file input
  would not work.
- `FontBridge` streams the chosen content URI into a temporary file in
  `filesDir/morphe-fonts`, checks the first four bytes to detect WOFF2, WOFF,
  TTF, or OTF, calls `fsync`, then renames the temp file to `custom.<format>`.
- Only after the rename succeeds does it update the `morphe_font` preferences:
  `enabled`, `font_name`, `font_file`, `font_format`, and `font_version`.
- The font is served at `/morphe/font/current?v=<version>` by
  `MorpheWebRouter.stream(...)`, which returns a `WebResourceResponse` backed by
  a `FileInputStream` and a `Content-Length` header.
- The response uses `Cache-Control: no-store`. The `v` query changes after every
  upload so the WebView does not reuse an old font.
- The file is streamed directly. There is no full-file byte array and no fixed
  size cap; the practical limit is free space in the app's private storage.
- Uploading another font replaces `custom.<format>` and deletes the previous
  font file after the new one is safely in place.

### Changing the font

Upload a different WOFF2, WOFF, TTF, or OTF file in **Custom Font Settings**.
No rebuild or re-patch is needed. The old file is deleted after the new one is
saved. Large fonts do not increase DEX size because the font stays on disk.

---

## 9. Runtime UI and chapter styling

`FontHook.onPageFinished` injects `FontUiData.JS`, then calls:

```text
MorpheFont.init(fontCss, enabled, name, hasFont)
```

`fontCss` contains an `@font-face` rule pointing at the local
`/morphe/font/current?v=...` URL, or an empty string when no font is stored.

Key points:

- `controller.js` gets the section HTML and CSS from
  `MorpheFontBridge.getHtml()` / `getCss()`. Markup is not concatenated into the
  injected JavaScript.
- When `hasFont` is false, the controller shows "No font selected", disables the
  toggle, and clears any injected font style.
- `FontBridge.install` registers the `font` namespace with `MorpheWebRouter`
  before the WebView loads a page. It also registers the JavaScript bridge.
- `apply()` writes `<style id="morphe-font-dynamic">` into **every** same-origin
  iframe, not just the first one.
- The style rule uses a repeated attribute selector
  (`html[data-morphe-font-root][data-morphe-font-root][data-morphe-font-root] ...`)
  so it outranks Libby's `html.RS-BIFOCAL * { font-family: ... !important }`
  OpenDyslexic rule.
- Toggle and upload events are delegated from the top document in the **capture**
  phase, so they keep working if Libby replaces the settings dialog's DOM.
- There is **no polling, no observer, and no recurring timer**. The controller
  uses three listeners: capture `click`, capture `change`, and capture `load`.
  Styling new/replaced chapter iframes is driven by the `load` listener;
  `apply()` at init handles iframes that already exist.
- Libby removes `.readability-dialog-sections` when the Appearance dialog closes,
  and it stops the Appearance click before it bubbles. A capture-phase `click`
  listener filters to the button whose `.nav-action-item-label` is `Appearance`.
  The dialog is created after the event, so one `setTimeout(0)` inserts the
  section. Multiple taps collapse into one pending injection.
- Two one-shot timers remain and are not polling: the 0 ms injection defer and a
  300 ms helper-style refresh after the section is first inserted.
- `FontHook` returns early for the `libbyapp.com` shell and for `/chapter-` URLs.

---

## 10. Gotchas already encountered (do not repeat)

| Symptom | Cause | Fix |
|---|---|---|
| `SDK location not found` | No SDK path for Gradle | `local.properties` with `sdk.dir=...` |
| `Gradle requires JVM 17+ ... configured to use JVM 11` | Stale `JAVA_HOME`/PATH in that process | Use JDK 21; restart shell |
| `UnsupportedClassVersionError ... class file version 65` | Ran Morphe jar with Java 11 | Run with JDK 21 |
| `[7,83] Error for input ';': Invalid text` | `FontHook;;->` — extra `;` after a class descriptor | Descriptor is `L...;`; write `$EXTENSION_CLASS->method(...)` |
| Reader freezes after opening settings | `MutationObserver` loop from rewriting `textContent` every callback | Write text/checked state only when the value changes; disarm the short-lived observer after injecting |
| Battery drain / constant work while reading | `setInterval` polling for iframes and the dialog | Use capture-phase `load` events and one capture-phase click/change listener; no recurring timers |
| Appearance click does not reach the document bubble listener | Libby stops propagation on its nav button | Listen in the capture phase and defer injection with one `setTimeout(0)` |
| Font only applies to the first chapter | `querySelector('iframe')` picks the first frame | Apply to every same-origin iframe |
| OpenDyslexic overrides the custom font | Libby's `html.RS-BIFOCAL * { ... !important }` has higher specificity | Use the repeated `data-morphe-font-root` selector |
| `appIconColor` exception | Passed `0xFF1F1F1F` (ARGB) | Use `0x1F1F1F` (`0xRRGGBB`) |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Different signing key | Uninstall the existing app first |
| Reader always says "No font selected" | No uploaded file, failed upload, or prefs cleared | Upload a supported font; check the status text under the upload button |
| `/morphe/font/current` returns 404 | Route not registered, or the stored file is missing | Ensure `FontBridge.install` ran and the `font_file` preference points at an existing file |
| Libby's normal requests break after the router hook | Scratch register collided with a parameter register | Use `v0`; `addFreeRegisters` returns a move count, not a register number |
| Build error about `extensions/libby.mpe` | Extension output still named `extensions/font.mpe` | Keep `extension { name = "extensions/libby.mpe" }` |
| Font does not change | Script not injected, route not registered, or CSS override | Enable WebView debugging and inspect with `chrome://inspect` |

PowerShell tip: `| Select-Object -Last 40` can hide the real error at the top of
a log. Capture the full output or use `Select-String` for the error line.

---

## 11. Coding conventions

- Kotlin patch files: `package app.libby.patches`.
- Java font extension: `package app.libby.font`.
- Java shared router: `package app.libby.web`.
- Use LF line endings in Kotlin/Java sources.
- Keep the patch's `execute` block minimal; logic belongs in the extension.
- Register a `/morphe/` route before the WebView loads, not from
  `onPageFinished`. `FontBridge.install` does this for the font route.
- Stream files with `WebResourceResponse` and a `FileInputStream`. Do not load
  fonts into a string or a full-file byte array in Java or JavaScript.
- Runtime code must not poll. Prefer event-driven hooks; disconnect observers and
  clear one-shot timers when their job is done.
- Fingerprints must avoid obfuscated names. Prefer framework method names,
  signatures, and stable string literals.
- A fingerprint that matches zero or multiple methods aborts the patch; that is
  intended. Update the fingerprint deliberately when the app changes.
- Do not commit `local.properties`, build outputs, or credentials.
- When adding a new Libby version, add it to `Constants.kt` and re-verify the
  fingerprint on that version before shipping.

---

## 12. Glossary

- **APK** — Android app package (a zip with DEX code, resources, manifest, signature).
- **DEX** — Android bytecode format, executed by ART.
- **smali** — human-readable assembly syntax for DEX.
- **Obfuscation (R8)** — renames classes/methods (e.g. `jp1`) to shrink the app.
- **Fingerprint** — a set of stable traits used to locate a method across versions.
- **Extension** — extra Java code compiled to DEX and merged into the app.
- **MPP** — Morphe patch bundle (compiled patches + extension DEX).
- **WebView** - Chromium-based browser component used by the app.
- **shouldInterceptRequest** - WebViewClient callback that can return a local
  response instead of making a network request.
- **Request router** - one interception hook that dispatches
  `/morphe/<namespace>/<path>` to a registered handler.
- **Route namespace** - the first path segment after `/morphe/`, such as `font`.
- **Streaming response** - a `WebResourceResponse` backed by a file
  `InputStream`; the file is not loaded into a string or byte array.
- **WOFF2** - compressed web font format supported by Chromium/WebView.
- **same-origin iframe** - child document reachable via `contentDocument`.
