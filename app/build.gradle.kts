plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.roost"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.roost"
        minSdk = 26
        // 34 on purpose: targeting 35 forces edge-to-edge layout, which the web UI doesn't need.
        targetSdk = 34
        versionCode = 2
        versionName = "1.1"
    }

    // One fixed key for every build, on every machine. Android only installs an update over
    // the existing app (keeping its saved logins) when the signature matches, so never
    // replace signing/roost.keystore.
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("signing/roost.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.biometric:biometric:1.1.0")
    testImplementation("junit:junit:4.13.2")
}
