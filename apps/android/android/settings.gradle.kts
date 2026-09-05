pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "yaqmc-android"
include(":app")

// Capacitor may be npm-hoisted to the workspace root or kept beside this app.
val capacitorAndroid = requireNotNull(
    sequenceOf(
        file("../node_modules/@capacitor/android/capacitor"),
        file("../../node_modules/@capacitor/android/capacitor"),
        file("../../../node_modules/@capacitor/android/capacitor"),
    ).firstOrNull { it.isDirectory },
) { "@capacitor/android is missing; run npm ci at the repository root" }
include(":capacitor-android")
project(":capacitor-android").projectDir = capacitorAndroid

val capacitorApp = requireNotNull(
    sequenceOf(
        file("../node_modules/@capacitor/app/android"),
        file("../../node_modules/@capacitor/app/android"),
        file("../../../node_modules/@capacitor/app/android"),
    ).firstOrNull { it.isDirectory },
) { "@capacitor/app is missing; run npm ci at the repository root" }
include(":capacitor-app")
project(":capacitor-app").projectDir = capacitorApp

val rustlsVerifierMaven = System.getenv("YAQMC_RUSTLS_VERIFIER_MAVEN_DIR")
require(!rustlsVerifierMaven.isNullOrBlank()) {
    "YAQMC_RUSTLS_VERIFIER_MAVEN_DIR is required; invoke Gradle through scripts/build-android.mjs"
}
dependencyResolutionManagement.repositories.maven {
    name = "rustlsPlatformVerifier"
    url = uri(rustlsVerifierMaven)
}

// Capacitor modules are linked explicitly because the generated Groovy settings
// fragment would declare :capacitor-android a second time in this Kotlin project.
