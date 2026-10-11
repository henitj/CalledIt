plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.calledit.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.calledit.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
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
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Bundle the website into the APK so the app and the site can never drift
// apart — this copies the current web app (html/css/js/assets) at build time.
// Landed under assets/www/… (served by NanoHTTPD as /… and /index.html).
val webAssetsRoot = layout.buildDirectory.dir("generated/webassets")

val copyWebAssets = tasks.register<Copy>("copyWebAssets") {
    from(rootProject.projectDir.parentFile) {
        include("index.html", "start.html", "trails.html", "social.html")
        include("manifest.webmanifest")
        include("css/**", "js/**", "assets/**")
    }
    into(webAssetsRoot.map { it.dir("www") })
}

android.sourceSets.getByName("main").assets.srcDir(webAssetsRoot)

tasks.named("preBuild") { dependsOn(copyWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
