package app.libby.font;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import app.libby.web.MorpheWebRouter;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.Locale;

/**
 * Native side of the font UI.
 *
 * The reader is a remote WebView page, and Libby's WebChromeClient does not
 * implement onShowFileChooser, so an HTML file input cannot open a picker.
 * This bridge opens the system document picker instead, copies the chosen font
 * into the app's internal storage, and serves it through the shared
 * /morphe/ router. Uploaded fonts form a small library: one file per font plus
 * a JSON index in SharedPreferences. Files are streamed from disk, never loaded
 * into a string.
 */
public final class FontBridge {

    private static final String TAG = "MorpheFont";
    private static final String PREFS = "morphe_font";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_SELECTED = "selected";
    private static final String KEY_LIBRARY = "library";

    // Older builds stored exactly one font. These keys are migrated on first read.
    private static final String KEY_LEGACY_NAME = "font_name";
    private static final String KEY_LEGACY_FILE = "font_file";
    private static final String KEY_LEGACY_FORMAT = "font_format";
    private static final String KEY_LEGACY_VERSION = "font_version";

    private static final String FONT_DIR = "morphe-fonts";
    private static final int REQUEST_CODE = 0x4D46;
    private static final String FONT_ROUTE = "font";

    // "current" keeps working for older injected CSS; new URLs use the font id
    // so switching fonts never reuses a cached response.
    private static final String CURRENT = "current";

    private static final MorpheWebRouter.RouteHandler FONT_HANDLER =
            (view, request, path) -> {
                if (view == null || request == null) {
                    return null;
                }
                if (!"GET".equalsIgnoreCase(request.getMethod())) {
                    return null;
                }

                Context context = view.getContext();
                if (context == null) {
                    return null;
                }

                JSONObject entry;
                synchronized (FontBridge.class) {
                    entry = CURRENT.equals(path)
                            ? selectedEntry(context)
                            : findEntry(library(context), path);
                }
                if (entry == null) {
                    return null;
                }

                File file = resolve(context, entry.optString("file"));
                if (file == null) {
                    return null;
                }

                return MorpheWebRouter.stream(file, mimeFor(entry.optString("format")));
            };

    private static WeakReference<WebView> pendingWebView = new WeakReference<>(null);

    private final WeakReference<WebView> webView;

    public FontBridge(WebView webView) {
        this.webView = new WeakReference<>(webView);
    }

    /**
     * Registers the bridge before the WebView loads a page. Calling
     * addJavascriptInterface from onPageFinished is too late for the current page.
     */
    public static void install(WebView webView) {
        if (webView != null) {
            MorpheWebRouter.register(FONT_ROUTE, FONT_HANDLER);
            webView.addJavascriptInterface(new FontBridge(webView), "MorpheFontBridge");
        }
    }

    @JavascriptInterface
    public String getHtml() {
        return FontUiData.HTML;
    }

    @JavascriptInterface
    public String getCss() {
        return FontUiData.CSS;
    }

    /**
     * Everything the UI needs to draw the list: the stored fonts, which one is
     * selected, and whether the custom font is switched on.
     */
    @JavascriptInterface
    public String getLibrary() {
        WebView view = webView.get();
        if (view == null) {
            return "{}";
        }
        return libraryStateJson(view.getContext());
    }

    @JavascriptInterface
    public void pickFont() {
        WebView view = webView.get();
        if (view == null) {
            return;
        }

        // JavascriptInterface methods run on a WebView worker thread.
        // getUrl()/getContext() and startActivityForResult must run on the UI thread.
        view.post(() -> {
            try {
                String url = view.getUrl();
                if (url == null || !url.contains("read.libbyshelf.com")) {
                    return;
                }

                Activity activity = activityFrom(view.getContext());
                if (activity == null) {
                    notifyError(view, "No activity");
                    return;
                }

                pendingWebView = new WeakReference<>(view);
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                activity.startActivityForResult(intent, REQUEST_CODE);
            } catch (Throwable t) {
                Log.e(TAG, "pickFont failed", t);
                notifyError(view, "Could not open the file picker: " + t);
            }
        });
    }

    @JavascriptInterface
    public void setEnabled(boolean enabled) {
        WebView view = webView.get();
        if (view == null) {
            return;
        }
        try {
            Context context = view.getContext();
            boolean hasFont = selectedEntry(context) != null;
            prefs(context).edit()
                    .putBoolean(KEY_ENABLED, hasFont && enabled)
                    .apply();
        } catch (Throwable t) {
            Log.e(TAG, "setEnabled failed", t);
        }
    }

    /**
     * Makes one stored font the active one and returns the updated library, so
     * the UI renders from one round trip.
     */
    @JavascriptInterface
    public String selectFont(String id) {
        WebView view = webView.get();
        if (view == null) {
            return "{}";
        }
        Context context = view.getContext();
        try {
            synchronized (FontBridge.class) {
                if (findEntry(library(context), id) != null) {
                    prefs(context).edit()
                            .putString(KEY_SELECTED, id)
                            .putBoolean(KEY_ENABLED, true)
                            .apply();
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "selectFont failed", t);
        }
        return libraryStateJson(context);
    }

    /**
     * Deletes one stored font and its file. Deleting the active font switches the
     * custom font off, so the reader falls back to the app's own typography; the
     * remaining fonts stay in the library.
     */
    @JavascriptInterface
    public String deleteFont(String id) {
        WebView view = webView.get();
        if (view == null || id == null || id.isEmpty()) {
            return "{}";
        }
        Context context = view.getContext();
        try {
            synchronized (FontBridge.class) {
                JSONArray stored = library(context);
                JSONArray remaining = new JSONArray();
                boolean removed = false;

                for (int i = 0; i < stored.length(); i++) {
                    JSONObject entry = stored.optJSONObject(i);
                    if (entry == null) {
                        continue;
                    }
                    if (id.equals(entry.optString("id"))) {
                        File file = resolve(context, entry.optString("file"));
                        if (file != null) {
                            file.delete();
                        }
                        removed = true;
                        continue;
                    }
                    remaining.put(entry);
                }

                if (removed) {
                    SharedPreferences.Editor editor = prefs(context).edit()
                            .putString(KEY_LIBRARY, remaining.toString());
                    if (id.equals(selectedId(context))) {
                        editor.putString(KEY_SELECTED, "")
                                .putBoolean(KEY_ENABLED, false);
                    }
                    editor.apply();
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "deleteFont failed", t);
        }
        return libraryStateJson(context);
    }

    /**
     * Called from the patched Activity.onActivityResult.
     */
    public static void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) {
            return;
        }

        WebView view = pendingWebView.get();
        pendingWebView = new WeakReference<>(null);
        if (view == null) {
            return;
        }

        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            notifyJs(view, "MorpheFont.onPickCancelled && MorpheFont.onPickCancelled();");
            return;
        }

        Uri uri = data.getData();
        Context context = view.getContext().getApplicationContext();
        new Thread(() -> handlePicked(view, context, uri), "MorpheFontPicker").start();
    }

    public static boolean isEnabled(Context context) {
        return selectedEntry(context) != null
                && prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static String fontName(Context context) {
        JSONObject entry = selectedEntry(context);
        return entry == null ? "" : entry.optString("name", "");
    }

    public static String fontFormat(Context context) {
        JSONObject entry = selectedEntry(context);
        return entry == null ? "woff2" : entry.optString("format", "woff2");
    }

    /**
     * Root-relative URL of the active font. The reader and chapter iframe are
     * same-origin, so this avoids CORS and the request is handled by
     * MorpheWebRouter before the network.
     */
    public static String fontUrl(Context context) {
        JSONObject entry = selectedEntry(context);
        if (entry == null) {
            return "";
        }
        File file = resolve(context, entry.optString("file"));
        long version = entry.optLong("added", file != null ? file.lastModified() : 0L);
        return urlFor(entry.optString("id"), version);
    }

    /**
     * Returns the active font file, or null when nothing is selected. The
     * canonical-path check keeps a malformed index from escaping the app's
     * private font directory.
     */
    public static File fontFile(Context context) {
        JSONObject entry = selectedEntry(context);
        return entry == null ? null : resolve(context, entry.optString("file"));
    }

    /**
     * JSON consumed by the injected UI and by FontHook:
     * {"selected":"id","enabled":true,"fonts":[{"id","name","format","size","url"}]}
     */
    public static String libraryStateJson(Context context) {
        try {
            synchronized (FontBridge.class) {
                JSONArray stored = library(context);
                JSONArray items = new JSONArray();
                String selected = selectedId(context);
                boolean selectedIsLive = false;

                for (int i = 0; i < stored.length(); i++) {
                    JSONObject entry = stored.optJSONObject(i);
                    if (entry == null) {
                        continue;
                    }
                    File file = resolve(context, entry.optString("file"));
                    if (file == null) {
                        // Index entry whose file disappeared; hide it.
                        continue;
                    }

                    String id = entry.optString("id");
                    JSONObject item = new JSONObject();
                    item.put("id", id);
                    item.put("name", entry.optString("name", "Custom font"));
                    item.put("format", entry.optString("format", "woff2"));
                    item.put("size", file.length());
                    item.put("url", urlFor(
                            id, entry.optLong("added", file.lastModified())));
                    items.put(item);

                    if (id.equals(selected)) {
                        selectedIsLive = true;
                    }
                }

                JSONObject state = new JSONObject();
                state.put("selected", selectedIsLive ? selected : "");
                state.put("enabled", selectedIsLive
                        && prefs(context).getBoolean(KEY_ENABLED, false));
                state.put("fonts", items);
                return state.toString();
            }
        } catch (Exception e) {
            Log.e(TAG, "libraryStateJson failed", e);
            return "{}";
        }
    }

    private static String urlFor(String id, long version) {
        return "/morphe/" + FONT_ROUTE + "/" + id + "?v=" + version;
    }

    private static void handlePicked(WebView view, Context context, Uri uri) {
        File dir = new File(context.getFilesDir(), FONT_DIR);
        File temp = null;

        try {
            if (!dir.exists() && !dir.mkdirs()) {
                notifyError(view, "Could not create the font folder");
                return;
            }

            String format;
            temp = new File(dir, "upload-" + System.nanoTime() + ".tmp");

            InputStream raw = context.getContentResolver().openInputStream(uri);
            if (raw == null) {
                notifyError(view, "Could not read the font");
                return;
            }

            try (InputStream in = new BufferedInputStream(raw);
                 FileOutputStream out = new FileOutputStream(temp)) {
                in.mark(4);
                byte[] header = new byte[4];
                if (!readHeader(in, header)) {
                    notifyError(view, "The file is empty");
                    return;
                }

                format = detectFormat(header);
                if (format == null) {
                    notifyError(view, "Unsupported font format");
                    return;
                }

                in.reset();
                copy(in, out);
                out.getFD().sync();
            }

            String id = newId();
            File font = new File(dir, id + "." + format);
            if (!temp.renameTo(font)) {
                notifyError(view, "Could not save the font");
                return;
            }
            temp = null;

            String name = displayName(context, uri);
            long added = System.currentTimeMillis();

            synchronized (FontBridge.class) {
                JSONArray stored = library(context);
                JSONObject entry = new JSONObject();
                entry.put("id", id);
                entry.put("name", name);
                entry.put("file", font.getName());
                entry.put("format", format);
                entry.put("added", added);
                stored.put(entry);

                prefs(context).edit()
                        .putBoolean(KEY_ENABLED, true)
                        .putString(KEY_SELECTED, id)
                        .putString(KEY_LIBRARY, stored.toString())
                        .apply();
            }

            cleanupUploads(dir);

            notifyJs(view, "if(window.MorpheFont){MorpheFont.onLibraryChanged("
                    + JSONObject.quote(libraryStateJson(context)) + ");}");
        } catch (Exception e) {
            Log.e(TAG, "handlePicked failed", e);
            notifyError(view, "Could not read the font");
        } finally {
            if (temp != null) {
                temp.delete();
            }
        }
    }

    private static boolean readHeader(InputStream in, byte[] header) throws IOException {
        int total = 0;
        while (total < header.length) {
            int read = in.read(header, total, header.length - total);
            if (read < 0) {
                break;
            }
            total += read;
        }
        return total == header.length;
    }

    private static void copy(InputStream in, FileOutputStream out) throws IOException {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }

    private static String detectFormat(byte[] bytes) {
        if (bytes == null || bytes.length < 4) {
            return null;
        }

        int b0 = bytes[0] & 0xff;
        int b1 = bytes[1] & 0xff;
        int b2 = bytes[2] & 0xff;
        int b3 = bytes[3] & 0xff;

        if (b0 == 'w' && b1 == 'O' && b2 == 'F' && b3 == '2') {
            return "woff2";
        }
        if (b0 == 'w' && b1 == 'O' && b2 == 'F' && b3 == 'F') {
            return "woff";
        }
        if (b0 == 'O' && b1 == 'T' && b2 == 'T' && b3 == 'O') {
            return "otf";
        }
        if (b0 == 0 && b1 == 1 && b2 == 0 && b3 == 0) {
            return "ttf";
        }
        if (b0 == 't' && b1 == 'r' && b2 == 'u' && b3 == 'e') {
            return "ttf";
        }
        if (b0 == 't' && b1 == 'y' && b2 == 'p' && b3 == '1') {
            return "ttf";
        }
        return null;
    }

    private static String mimeFor(String format) {
        switch (format) {
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "ttf":
                return "font/ttf";
            case "otf":
                return "font/otf";
            default:
                return "application/octet-stream";
        }
    }

    private static void cleanupUploads(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.getName().endsWith(".tmp")) {
                file.delete();
            }
        }
    }

    /**
     * Resolves an index file name inside the private font directory. Returns null
     * for anything that is missing, empty, or outside that directory.
     */
    private static File resolve(Context context, String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return null;
        }

        File dir = new File(context.getFilesDir(), FONT_DIR);
        File file = new File(dir, fileName);
        try {
            String dirPath = dir.getCanonicalPath();
            String filePath = file.getCanonicalPath();
            if (!filePath.startsWith(dirPath + File.separator)) {
                return null;
            }
        } catch (IOException e) {
            return null;
        }

        return file.isFile() && file.length() > 0 ? file : null;
    }

    private static JSONArray library(Context context) {
        String raw = prefs(context).getString(KEY_LIBRARY, "");
        if (raw != null && !raw.isEmpty()) {
            try {
                return new JSONArray(raw);
            } catch (JSONException ignored) {
                // Corrupt index: fall through and rebuild it from scratch.
            }
        }
        return migrateLegacy(context);
    }

    /**
     * Converts the pre-library single-font preferences into a one-entry library.
     * The old file keeps its name, so nothing is copied or renamed.
     */
    private static JSONArray migrateLegacy(Context context) {
        JSONArray result = new JSONArray();
        SharedPreferences prefs = prefs(context);
        String file = prefs.getString(KEY_LEGACY_FILE, null);

        if (file == null || file.isEmpty()) {
            return result;
        }

        if (resolve(context, file) == null) {
            prefs.edit()
                    .remove(KEY_LEGACY_FILE)
                    .remove(KEY_LEGACY_NAME)
                    .remove(KEY_LEGACY_FORMAT)
                    .remove(KEY_LEGACY_VERSION)
                    .putBoolean(KEY_ENABLED, false)
                    .putString(KEY_SELECTED, "")
                    .apply();
            return result;
        }

        try {
            JSONObject entry = new JSONObject();
            entry.put("id", newId());
            entry.put("name", prefs.getString(KEY_LEGACY_NAME, "Custom font"));
            entry.put("file", file);
            entry.put("format", prefs.getString(KEY_LEGACY_FORMAT, formatFromName(file)));
            entry.put("added", legacyVersion(prefs, file));
            result.put(entry);

            prefs.edit()
                    .putString(KEY_LIBRARY, result.toString())
                    .putString(KEY_SELECTED, entry.getString("id"))
                    .remove(KEY_LEGACY_FILE)
                    .remove(KEY_LEGACY_NAME)
                    .remove(KEY_LEGACY_FORMAT)
                    .remove(KEY_LEGACY_VERSION)
                    .apply();
        } catch (JSONException ignored) {
            // Leave the old keys in place; the next read retries the migration.
        }
        return result;
    }

    private static long legacyVersion(SharedPreferences prefs, String file) {
        String raw = prefs.getString(KEY_LEGACY_VERSION, "");
        try {
            if (raw != null && !raw.isEmpty()) {
                return Long.parseLong(raw);
            }
        } catch (NumberFormatException ignored) {
            // Fall back to zero; the id route still serves the file.
        }
        return 0L;
    }

    private static String formatFromName(String fileName) {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return "woff2";
        }
        String format = fileName.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (format) {
            case "woff2":
            case "woff":
            case "ttf":
            case "otf":
                return format;
            default:
                return "woff2";
        }
    }

    private static String selectedId(Context context) {
        String id = prefs(context).getString(KEY_SELECTED, "");
        return id != null ? id : "";
    }

    private static JSONObject selectedEntry(Context context) {
        JSONObject entry = findEntry(library(context), selectedId(context));
        return entry != null && resolve(context, entry.optString("file")) != null
                ? entry
                : null;
    }

    private static JSONObject findEntry(JSONArray library, String id) {
        if (library == null || id == null || id.isEmpty()) {
            return null;
        }
        for (int i = 0; i < library.length(); i++) {
            JSONObject entry = library.optJSONObject(i);
            if (entry != null && id.equals(entry.optString("id"))) {
                return entry;
            }
        }
        return null;
    }

    private static String newId() {
        return Long.toString(System.currentTimeMillis(), 36)
                + "-" + Long.toString(System.nanoTime() & 0xFFFFFF, 36);
    }

    private static String displayName(Context context, Uri uri) {
        String name = null;
        try (Cursor cursor = context.getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null,
                null,
                null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    name = cursor.getString(index);
                }
            }
        } catch (Exception ignored) {
            // Fall back to the URI segment.
        }

        if (name == null || name.isEmpty()) {
            name = uri.getLastPathSegment();
        }
        return name == null || name.isEmpty() ? "Custom font" : name;
    }

    private static Activity activityFrom(Context context) {
        Context current = context;
        while (current instanceof ContextWrapper) {
            if (current instanceof Activity) {
                return (Activity) current;
            }
            Context base = ((ContextWrapper) current).getBaseContext();
            if (base == null || base == current) {
                break;
            }
            current = base;
        }
        return current instanceof Activity ? (Activity) current : null;
    }

    private static SharedPreferences prefs(Context context) {
        Context app = context.getApplicationContext();
        return (app != null ? app : context).getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void notifyError(WebView view, String message) {
        notifyJs(view, "MorpheFont.onFontError && MorpheFont.onFontError("
                + JSONObject.quote(message) + ");");
    }

    private static void notifyJs(WebView view, String script) {
        if (view == null) {
            return;
        }
        view.post(() -> view.evaluateJavascript(script, null));
    }
}
