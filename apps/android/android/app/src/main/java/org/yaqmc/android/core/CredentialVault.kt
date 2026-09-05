package org.yaqmc.android.core

import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal fun interface CredentialKeyProvider {
    fun key(): SecretKey
}

internal interface CredentialBlobStore {
    fun read(name: String): String?

    fun write(name: String, value: String): Boolean

    fun remove(name: String): Boolean
}

/** Pure AES-GCM envelope policy, kept testable outside Android Keystore. */
internal class CredentialVault(
    private val applicationId: String,
    private val blobs: CredentialBlobStore,
    private val keys: CredentialKeyProvider,
) {
    @Synchronized
    fun put(name: String, value: String) {
        requireName(name)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, keys.key())
            updateAAD(aad(name))
        }
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        check(blobs.write(name, encode(cipher.iv) + ":" + encode(encrypted))) {
            "credential ciphertext could not be persisted"
        }
    }

    @Synchronized
    fun get(name: String): String? {
        requireName(name)
        val packed = blobs.read(name) ?: return null
        val parts = packed.split(':', limit = 2)
        if (parts.size != 2 || parts.any(String::isBlank)) {
            throw unreadable("credential ciphertext is malformed")
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(128, decode(parts[0])))
            cipher.updateAAD(aad(name))
            String(cipher.doFinal(decode(parts[1])), StandardCharsets.UTF_8)
        } catch (error: Exception) {
            throw unreadable("credential key is unavailable or ciphertext authentication failed", error)
        }
    }

    @Synchronized
    fun remove(name: String) {
        requireName(name)
        check(blobs.remove(name)) { "credential ciphertext could not be removed" }
    }

    private fun aad(name: String) = "$applicationId:$name".toByteArray(StandardCharsets.UTF_8)

    private fun requireName(name: String) {
        require(name.length in 1..128 && name.none(Char::isISOControl)) {
            "invalid credential key"
        }
    }

    // A read failure must not mutate durable state. Android Keystore can fail temporarily while
    // the device is locked or its service is recovering; deleting here would turn that transient
    // failure into a permanent logout. Explicit logout and a successful replacement remain the
    // only operations that remove or overwrite a stored credential.
    private fun unreadable(message: String, cause: Throwable? = null) =
        IllegalStateException("$message; retry or account sign-in may be required", cause)

    private fun encode(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    private fun decode(value: String) = Base64.getDecoder().decode(value)

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
