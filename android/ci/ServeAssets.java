package com.calledit.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

/**
 * Runs the APK's own LocalServer on a desktop JVM. The folder given is the
 * APK's extracted assets/ directory and paths resolve exactly like the app's
 * getAssets().open(path) — LocalServer asks for "www/…". Used by
 * test/browser/apk-check.mjs to test the files inside the built APK at
 * http://127.0.0.1:8765 (the same origin the app uses).
 *
 *   java -cp out com.calledit.app.ServeAssets <extracted-apk>/assets [port]
 */
public class ServeAssets {
    public static void main(String[] args) throws Exception {
        final File root = new File(args.length > 0 ? args[0] : ".").getCanonicalFile();
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 8765;
        if (!new File(root, "www/index.html").isFile()) throw new FileNotFoundException(root + "/www/index.html");
        LocalServer srv = new LocalServer(port, new LocalServer.AssetSource() {
            @Override
            public InputStream open(String path) throws IOException {
                File f = new File(root, path).getCanonicalFile();
                if (!f.getPath().startsWith(root.getPath()) || !f.isFile()) throw new FileNotFoundException(path);
                return new FileInputStream(f);
            }
        });
        srv.start();
        System.out.println("LISTENING http://127.0.0.1:" + srv.getPort() + "/ serving " + root);
        System.out.flush();
        while (true) Thread.sleep(60000);
    }
}
