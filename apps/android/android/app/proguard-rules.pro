# JNI entry points are looked up by name from Rust.
-keep class org.yaqmc.android.core.CoreManager { *; }
-keep class org.yaqmc.android.core.CoreManager$* { *; }
-keep class org.yaqmc.android.media.CorePlayer { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
