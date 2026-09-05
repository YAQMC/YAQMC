plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseRequested = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
val releaseKeystore = System.getenv("ANDROID_RELEASE_KEYSTORE")
val releaseAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
val releaseStorePassword = System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
val releaseKeyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
val buildCommit = System.getenv("YAQMC_BUILD_COMMIT")
    ?.takeIf { it.matches(Regex("^[0-9a-f]{40}$")) }
    ?: "unknown"

android {
    namespace = "org.yaqmc.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.yaqmc.android"
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("YAQMC_VERSION_CODE") ?: "1").toIntOrNull() ?: 1
        versionName = System.getenv("YAQMC_VERSION_NAME") ?: "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "YAQMC_BUILD_COMMIT", "\"$buildCommit\"")
    }

    ndkVersion = "28.2.13676358"
    buildToolsVersion = "36.0.0"

    signingConfigs {
        create("release") {
            if (releaseRequested) {
                fun required(name: String, value: String?): String =
                    value ?: error("$name is required for a release build")
                storeFile = file(required("ANDROID_RELEASE_KEYSTORE", releaseKeystore))
                storePassword = required("ANDROID_RELEASE_STORE_PASSWORD", releaseStorePassword)
                keyAlias = required("ANDROID_RELEASE_KEY_ALIAS", releaseAlias)
                keyPassword = required("ANDROID_RELEASE_KEY_PASSWORD", releaseKeyPassword)
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "YAQMC Debug")
            ndk {
                abiFilters.clear()
                abiFilters.add("arm64-v8a")
                abiFilters.add("x86_64")
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            ndk {
                abiFilters.clear()
                abiFilters.add("arm64-v8a")
            }
        }
    }

    // Native libraries are copied by the Rust/core build into a build output directory.
    // Nothing under src/main/jniLibs is used, avoiding checked-in binaries.
    val generatedJni = layout.buildDirectory.dir("generated/jniLibs").get().asFile
    val externalJni = System.getenv("YAQMC_ANDROID_NATIVE_LIB_DIR")
    sourceSets["main"].jniLibs.srcDirs(externalJni ?: generatedJni)
    sourceSets["test"].resources.srcDir("../../../../packages/yaqmc-client/fixtures")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    kotlinOptions {
        jvmTarget = "21"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(project(":capacitor-android"))
    implementation(project(":capacitor-app"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.media3:media3-common:1.10.1")
    implementation("androidx.media3:media3-session:1.10.1")
    implementation("rustls:rustls-platform-verifier:0.1.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.2.20")
    testImplementation("androidx.test:core:1.7.0")
}
