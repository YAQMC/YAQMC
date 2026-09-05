package org.yaqmc.android.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** AES-256-GCM credential backend. Key material never leaves Android Keystore. */
class CredentialStore(context: Context) {
    private val prefs = context.getSharedPreferences("yaqmc_credentials", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val vault = CredentialVault(
        applicationId = context.packageName,
        blobs = object : CredentialBlobStore {
            override fun read(name: String): String? = prefs.getString(name, null)

            override fun write(name: String, value: String): Boolean =
                prefs.edit().putString(name, value).commit()

            override fun remove(name: String): Boolean = prefs.edit().remove(name).commit()
        },
        keys = CredentialKeyProvider(::key),
    )

    @Synchronized
    fun put(name: String, value: String) = vault.put(name, value)

    @Synchronized
    fun get(name: String): String? = vault.get(name)

    @Synchronized
    fun remove(name: String) = vault.remove(name)

    private fun key(): SecretKey = (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)
        ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }

    private companion object {
        const val KEY_ALIAS = "yaqmc.credentials.v1"
    }
}
