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

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;

/**
 * Native side of the font UI.
 *
 * The reader is a remote WebView page, and Libby's WebChromeClient does not
 * implement onShowFileChooser, so an HTML file input cannot open a picker.
 * This bridge opens the system document picker instead, copies the chosen font
 * into the app's internal storage, and serves it through the shared
 * /morphe/ router. The file is streamed from disk, never loaded into a string.
 */
public final class FontBridge {

    private static final String TAG = "MorpheFont";
    private static final String PREFS = "morphe_font";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_NAME = "font_name";
    private static final String KEY_FILE = "font_file";
    private static final String KEY_FORMAT = "font_format";
    private static final String KEY_VERSION = "font_version";
    private static final String FONT_DIR = "morphe-fonts";
    private static final int REQUEST_CODE = 0x4D46;
    private static final String FONT_ROUTE = "font";
    private static final String FONT_PATH = "current";

    private static final MorpheWebRouter.RouteHandler FONT_HANDLER =
            (view, request, path) -> {
                if (view == null || request == null) {
                    return null;
                }
                if (!"GET".equalsIgnoreCase(request.getMethod())) {
                    return null;
                }
                if (!FONT_PATH.equals(path)) {
                    return null;
                }

                Context context = view.getContext();
                if (context == null) {
                    return null;
                }

                File file = fontFile(context);
                if (file == null) {
                    return null;
                }

                return MorpheWebRouter.stream(file, mimeFor(fontFormat(context)));
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
            boolean hasFont = fontFile(context) != null;
            prefs(context).edit()
                    .putBoolean(KEY_ENABLED, hasFont && enabled)
                    .apply();
        } catch (Throwable t) {
            Log.e(TAG, "setEnabled failed", t);
        }
    }

    @JavascriptInterface
    public String getState() {
        WebView view = webView.get();
        if (view == null) {
            return "{}";
        }

        Context context = view.getContext();
        try {
            File file = fontFile(context);
            boolean hasFont = file != null;
            JSONObject json = new JSONObject();
            json.put("enabled", hasFont && isEnabled(context));
            json.put("name", hasFont ? fontName(context) : "");
            json.put("hasFont", hasFont);
            json.put("url", hasFont ? fontUrl(context) : "");
            json.put("format", hasFont ? fontFormat(context) : "");
            return json.toString();
        } catch (Exception e) {
            return "{}";
        }
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
        return fontFile(context) != null && prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static String fontName(Context context) {
        if (fontFile(context) == null) {
            return "";
        }
        String name = prefs(context).getString(KEY_NAME, "");
        return name != null ? name : "";
    }

    public static String fontFormat(Context context) {
        return prefs(context).getString(KEY_FORMAT, "woff2");
    }

    /**
     * Returns the saved font file, or null when the user has not uploaded one.
     * The canonical-path check keeps a malformed preference from escaping the
     * app's private font directory.
     */
    public static File fontFile(Context context) {
        String name = prefs(context).getString(KEY_FILE, null);
        if (name == null || name.isEmpty()) {
            return null;
        }

        File dir = new File(context.getFilesDir(), FONT_DIR);
        File file = new File(dir, name);
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

    public static String fontVersion(Context context) {
        String version = prefs(context).getString(KEY_VERSION, null);
        if (version != null && !version.isEmpty()) {
            return version;
        }
        File file = fontFile(context);
        return file == null ? "" : Long.toString(file.lastModified());
    }

    /**
     * Root-relative URL. The reader and chapter iframe are same-origin, so this
     * avoids CORS and the request is handled by MorpheWebRouter before the network.
     */
    public static String fontUrl(Context context) {
        if (fontFile(context) == null) {
            return "";
        }
        return "/morphe/" + FONT_ROUTE + "/" + FONT_PATH
                + "?v=" + fontVersion(context);
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

            File font = new File(dir, "custom." + format);
            if (!temp.renameTo(font)) {
                notifyError(view, "Could not save the font");
                return;
            }
            temp = null;

            String name = displayName(context, uri);
            long version = System.currentTimeMillis();

            prefs(context).edit()
                    .putBoolean(KEY_ENABLED, true)
                    .putString(KEY_NAME, name)
                    .putString(KEY_FILE, font.getName())
                    .putString(KEY_FORMAT, format)
                    .putString(KEY_VERSION, Long.toString(version))
                    .apply();

            deleteOtherFonts(dir, font);

            String url = "/morphe/" + FONT_ROUTE + "/" + FONT_PATH + "?v=" + version;
            notifyJs(view, "if(window.MorpheFont){MorpheFont.onFontPicked("
                    + JSONObject.quote(name) + ","
                    + JSONObject.quote(url) + ","
                    + JSONObject.quote(format) + ");}");
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

    private static void deleteOtherFonts(File dir, File keep) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }

        for (File file : files) {
            if (file.equals(keep)) {
                continue;
            }
            String name = file.getName();
            if (name.startsWith("custom.") || name.endsWith(".tmp")) {
                file.delete();
            }
        }
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
