package com.calledit.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * JVM test for the APK's LocalServer (no Android needed).
 * Serves the repo's website the way the app serves assets/www, then fires
 * real HTTP requests at it — including an idle "preconnect" socket.
 *
 *   ecj/javac -source 1.7 -target 1.7 -d out LocalServer.java android/ci/LocalServerTest.java
 *   java -cp out com.calledit.app.LocalServerTest <repo-root>
 */
public class LocalServerTest {
    static int failures = 0;

    static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  -> " + detail));
        if (!ok) failures++;
    }

    static class Resp {
        int status;
        Map<String, String> headers = new HashMap<String, String>();
        byte[] body = new byte[0];
    }

    static Resp request(int port, String raw) throws IOException {
        Socket s = new Socket("127.0.0.1", port);
        s.setSoTimeout(10000);
        s.getOutputStream().write(raw.getBytes("UTF-8"));
        s.getOutputStream().flush();
        InputStream in = s.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        s.close();
        byte[] all = bos.toByteArray();
        int split = -1;
        for (int i = 0; i + 3 < all.length; i++) {
            if (all[i] == '\r' && all[i + 1] == '\n' && all[i + 2] == '\r' && all[i + 3] == '\n') { split = i; break; }
        }
        Resp r = new Resp();
        if (split < 0) return r;
        String head = new String(all, 0, split, "UTF-8");
        String[] lines = head.split("\r\n");
        r.status = Integer.parseInt(lines[0].split(" ")[1]);
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) r.headers.put(lines[i].substring(0, c).trim().toLowerCase(), lines[i].substring(c + 1).trim());
        }
        int len = all.length - split - 4;
        r.body = new byte[len];
        System.arraycopy(all, split + 4, r.body, 0, len);
        return r;
    }

    static byte[] file(File root, String rel) throws IOException {
        FileInputStream in = new FileInputStream(new File(root, rel));
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    static String get(String path) {
        return "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nUser-Agent: Mozilla/5.0 (Linux; Android 14; wv)\r\n"
                + "Accept: */*\r\nAccept-Encoding: gzip, deflate\r\nReferer: http://127.0.0.1:8765/index.html\r\n\r\n";
    }

    public static void main(String[] args) throws Exception {
        final File root = new File(args.length > 0 ? args[0] : ".");
        final LocalServer srv = new LocalServer(0, new LocalServer.AssetSource() {
            @Override
            public InputStream open(String path) throws IOException {
                if (!path.startsWith("www/")) throw new FileNotFoundException(path);
                File f = new File(root, path.substring(4));
                if (!f.isFile()) throw new FileNotFoundException(path);
                return new FileInputStream(f);
            }
        });
        srv.start();
        final int port = srv.getPort();

        /* a browser preconnect: opens a socket and sends nothing */
        Socket idle = new Socket("127.0.0.1", port);

        long t0 = System.currentTimeMillis();
        Resp r = request(port, get("/trails.html"));
        long ms = System.currentTimeMillis() - t0;
        byte[] want = file(root, "trails.html");
        check("GET /trails.html served while an idle preconnect socket is open (" + ms + " ms)", r.status == 200 && ms < 3000, "status " + r.status + " in " + ms + " ms");
        check("trails.html body identical + Content-Length", java.util.Arrays.equals(r.body, want)
                && String.valueOf(want.length).equals(r.headers.get("content-length")), r.headers.toString());
        check("text/html mime", "text/html; charset=utf-8".equals(r.headers.get("content-type")), r.headers.get("content-type"));

        r = request(port, get("/"));
        check("GET / → index.html", r.status == 200 && java.util.Arrays.equals(r.body, file(root, "index.html")), "status " + r.status);

        r = request(port, get("/index.html?from=apk#top"));
        check("query + hash ignored", r.status == 200, "status " + r.status);

        r = request(port, get("/vendor/leaflet/leaflet.js"));
        check("Leaflet JS (147 KB) complete + JS mime", r.status == 200 && java.util.Arrays.equals(r.body, file(root, "vendor/leaflet/leaflet.js"))
                && r.headers.get("content-type").startsWith("text/javascript"), "status " + r.status + " len " + r.body.length);

        r = request(port, get("/assets/cartoon-biker.jpg"));
        check("binary JPEG identical + image/jpeg", r.status == 200 && java.util.Arrays.equals(r.body, file(root, "assets/cartoon-biker.jpg"))
                && "image/jpeg".equals(r.headers.get("content-type")), "status " + r.status);

        r = request(port, get("/js/trails%2Ejs"));
        check("percent-encoded path decoded", r.status == 200 && r.body.length == file(root, "js/trails.js").length, "status " + r.status);

        r = request(port, "HEAD /index.html HTTP/1.1\r\nHost: x\r\n\r\n");
        check("HEAD: headers only", r.status == 200 && r.body.length == 0 && r.headers.get("content-length") != null, "status " + r.status + " body " + r.body.length);

        r = request(port, get("/nope.html"));
        check("missing file → 404", r.status == 404, "status " + r.status);

        r = request(port, get("/../README.md"));
        check("path traversal → 403", r.status == 403, "status " + r.status);
        r = request(port, get("/%2e%2e/README.md"));
        check("encoded traversal → 403", r.status == 403, "status " + r.status);

        r = request(port, "POST /index.html HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi");
        check("POST → 405", r.status == 405, "status " + r.status);

        /* 24 parallel requests, like a page load */
        ExecutorService ex = Executors.newFixedThreadPool(12);
        final String[] paths = {"/index.html", "/css/styles.css", "/js/app.js", "/js/trails.js", "/js/config.js", "/assets/icon.png"};
        List<Future<Integer>> fs = new ArrayList<Future<Integer>>();
        for (int i = 0; i < 24; i++) {
            final String p = paths[i % paths.length];
            fs.add(ex.submit(new Callable<Integer>() {
                @Override
                public Integer call() throws Exception {
                    return request(port, get(p)).status;
                }
            }));
        }
        int ok = 0;
        for (Future<Integer> f : fs) if (f.get() == 200) ok++;
        ex.shutdown();
        check("24 parallel requests all 200", ok == 24, ok + "/24");

        check("percentDecode keeps '+'", "/a+b c".equals(LocalServer.percentDecode("/a+b%20c")), LocalServer.percentDecode("/a+b%20c"));
        check("mime webp/woff2/manifest", LocalServer.mimeFor("x.webp").equals("image/webp") && LocalServer.mimeFor("f.woff2").equals("font/woff2")
                && LocalServer.mimeFor("manifest.webmanifest").equals("application/manifest+json"), "");

        idle.close();
        srv.stopServer();
        System.out.println(failures == 0 ? "\nLocalServer: all checks passed." : "\n" + failures + " FAILURES");
        System.exit(failures == 0 ? 0 : 1);
    }
}
