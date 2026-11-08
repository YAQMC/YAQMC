# JNI entry points are looked up by name from Rust.
-keep class org.yaqmc.android.core.CoreManager { *; }
-keep class org.yaqmc.android.core.CoreManager$* { *; }
-keep class org.yaqmc.android.media.CorePlayer { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
# Optional OEM plugins are named in the application manifest.
-keep class * implements org.yaqmc.android.lyrics.SystemLyricsPlugin { *; }
-keep class org.yaqmc.android.lyrics.SurfaceLyric { *; }
