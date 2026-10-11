package com.calledit.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tiny HTTP/1.1 file server for the bundled web app (assets/www/...).
 *
 * Pure Java on purpose (no android.* imports) so it can be unit-tested on a
 * desktop JVM — see test/LocalServerTest.java.
 *
 * - one pooled thread per connection, 15 s socket timeout: a browser
 *   "preconnect" socket that never sends a request can't block other pages
 * - reads the full request head before answering (no TCP resets that cut
 *   large responses short), GET + HEAD, 403 for "..", 404 for missing files
 */
public class LocalServer extends Thread {

    /** Where files come from: on Android, AssetManager.open("www/…"). */
    public interface AssetSource {
        InputStream open(String path) throws IOException;
    }

    private final ServerSocket serverSocket;
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private final AssetSource assets;
    private volatile boolean running = true;

    public LocalServer(int port, AssetSource assets) throws IOException {
        this.assets = assets;
        serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress("127.0.0.1", port));
        setDaemon(true);
        setName("CalledIt-LocalServer");
    }

    public int getPort() {
        return serverSocket.getLocalPort();
    }

    public void stopServer() {
        running = false;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    @Override
    public void run() {
        while (running) {
            try {
                final Socket socket = serverSocket.accept();
                pool.execute(new Runnable() {
                    @Override
                    public void run() {
                        handle(socket);
                    }
                });
            } catch (SocketException e) {
                break;                                   // server closed
            } catch (Exception e) {
                System.err.println("CalledIt LocalServer accept failed: " + e);
            }
        }
    }

    void handle(Socket socket) {
        InputStream in = null;
        try {
            socket.setSoTimeout(15000);
            in = socket.getInputStream();
            /* read the whole request head (request line + headers) */
            StringBuilder head = new StringBuilder();
            int c, nl = 0;
            while ((c = in.read()) != -1) {
                if (head.length() < 16384) head.append((char) c);
                if (c == '\n') {
                    nl++;
                    if (nl == 2) break;                  // blank line = end of headers
                } else if (c != '\r') {
                    nl = 0;
                }
            }
            if (head.length() == 0) return;              // preconnect that never sent anything
            String requestLine = head.toString().split("\r?\n", 2)[0];
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";

            byte[] body;
            String status = "HTTP/1.1 200 OK";
            String mime = "application/octet-stream";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            int h = path.indexOf('#');
            if (h >= 0) path = path.substring(0, h);
            path = percentDecode(path);
            if (path.equals("/") || path.length() == 0) path = "/index.html";
            if (!path.startsWith("/")) path = "/" + path;

            if (!method.equals("GET") && !method.equals("HEAD")) {
                status = "HTTP/1.1 405 Method Not Allowed";
                body = bytes("Method not allowed");
                mime = "text/plain; charset=utf-8";
            } else if (path.contains("..") || path.contains("\\") || path.indexOf('\0') >= 0) {
                status = "HTTP/1.1 403 Forbidden";
                body = bytes("Forbidden");
                mime = "text/plain; charset=utf-8";
            } else {
                InputStream asset;
                try {
                    asset = assets.open("www" + path);
                } catch (IOException e) {
                    asset = null;
                }
                if (asset == null) {
                    status = "HTTP/1.1 404 Not Found";
                    body = bytes("Not found");
                    mime = "text/plain; charset=utf-8";
                } else {
                    body = readAll(asset);
                    mime = mimeFor(path);
                }
            }

            OutputStream out = socket.getOutputStream();
            String headers = status + "\r\nContent-Type: " + mime
                    + "\r\nContent-Length: " + body.length
                    + "\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff"
                    + "\r\nConnection: close\r\n\r\n";
            out.write(headers.getBytes("UTF-8"));
            if (!method.equals("HEAD")) out.write(body);
            out.flush();
            try {
                socket.shutdownOutput();
            } catch (IOException ignored) {
            }
        } catch (IOException e) {
            /* client went away / timed out — nothing to do */
        } finally {
            try {
                if (in != null) in.close();
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static byte[] bytes(String s) throws IOException {
        return s.getBytes("UTF-8");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    /** %XX → UTF-8 (a literal '+' stays a '+', as in URL paths). */
    static String percentDecode(String s) {
        if (s.indexOf('%') < 0) return s;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    out.write((hi << 4) | lo);
                    i += 2;
                    continue;
                }
            }
            byte[] b;
            try {
                b = String.valueOf(ch).getBytes("UTF-8");
            } catch (IOException e) {
                b = new byte[]{(byte) '?'};
            }
            out.write(b, 0, b.length);
        }
        try {
            return out.toString("UTF-8");
        } catch (IOException e) {
            return s;
        }
    }

    static String mimeFor(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : "";
        if (ext.equals("html") || ext.equals("htm")) return "text/html; charset=utf-8";
        if (ext.equals("js") || ext.equals("mjs")) return "text/javascript; charset=utf-8";
        if (ext.equals("css")) return "text/css; charset=utf-8";
        if (ext.equals("json") || ext.equals("map")) return "application/json; charset=utf-8";
        if (ext.equals("webmanifest")) return "application/manifest+json";
        if (ext.equals("png")) return "image/png";
        if (ext.equals("jpg") || ext.equals("jpeg")) return "image/jpeg";
        if (ext.equals("webp")) return "image/webp";
        if (ext.equals("gif")) return "image/gif";
        if (ext.equals("svg")) return "image/svg+xml";
        if (ext.equals("ico")) return "image/x-icon";
        if (ext.equals("woff2")) return "font/woff2";
        if (ext.equals("woff")) return "font/woff";
        if (ext.equals("ttf")) return "font/ttf";
        if (ext.equals("txt")) return "text/plain; charset=utf-8";
        if (ext.equals("xml")) return "application/xml";
        if (ext.equals("mp3")) return "audio/mpeg";
        if (ext.equals("wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
