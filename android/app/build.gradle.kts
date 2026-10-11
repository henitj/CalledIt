plugins {
    id("com.android.application")
}

android {
    namespace = "com.calledit.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.calledit.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "1.2.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Signed with the debug key so users can install it directly;
            // replace with a release keystore when you publish.
            signingConfig = signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

// Bundle the website into the APK so the app and the site can never drift
// apart — this copies the current web app (html/css/js/assets) at build time.
// Landed under assets/www/… (served by LocalServer as /… and /index.html).
val webAssetsRoot = layout.buildDirectory.dir("generated/webassets")

val copyWebAssets = tasks.register<Copy>("copyWebAssets") {
    from(rootProject.projectDir.parentFile) {
        include("index.html", "start.html", "trails.html", "social.html")
        include("manifest.webmanifest")
        include("css/**", "js/**", "assets/**", "vendor/**")
    }
    into(webAssetsRoot.map { it.dir("www") })
}

android.sourceSets.getByName("main").assets.srcDir(webAssetsRoot)

tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    // Intentionally empty: the app uses only framework APIs, so it builds
    // with or without access to Google's Maven (see android/ci/build-apk.sh).
}
