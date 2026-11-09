pluginManagement {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val githubPackagesUser =
    System.getenv("YAQMC_GITHUB_PACKAGES_USER")
        ?.takeIf(String::isNotBlank)
        ?: System.getenv("GITHUB_ACTOR")?.takeIf(String::isNotBlank)
val githubPackagesToken =
    System.getenv("YAQMC_GITHUB_PACKAGES_TOKEN")
        ?.takeIf(String::isNotBlank)
        ?: System.getenv("GITHUB_TOKEN")?.takeIf(String::isNotBlank)

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        google()
        mavenCentral()

        mavenLocal {
            content {
                includeGroup("dev.yaqmc")
            }
        }

        // Local builds and CI publish the pinned AMLL source to mavenLocal (see docs/android.md).
        // Authenticated builds may also resolve a published copy from GitHub Packages.
        if (githubPackagesUser != null && githubPackagesToken != null) {
            maven {
                name = "yaqmcAmllGitHubPackages"
                url = uri("https://maven.pkg.github.com/YAQMC/amll-android")
                credentials {
                    username = githubPackagesUser
                    password = githubPackagesToken
                }
                content {
                    includeGroup("dev.yaqmc")
                }
            }
        }
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

dependencyResolutionManagement.repositories.maven {
    name = "rustlsPlatformVerifier"
    // Pin the upstream Maven archive; the AAR includes scoped CRL network permissions.
    url = uri("https://raw.githubusercontent.com/rustls/rustls-platform-verifier/1aa691352a5e0c215210dfc9a3c2f2078639dc91/android-release-support/maven/")
    content { includeGroup("org.rustls") }
}

// Capacitor modules are linked explicitly because the generated Groovy settings
// fragment would declare :capacitor-android a second time in this Kotlin project.
