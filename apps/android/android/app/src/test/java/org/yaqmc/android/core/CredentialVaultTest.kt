package org.yaqmc.android.core

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class CredentialVaultTest {
    @Test
    fun `round trip stores authenticated ciphertext instead of plaintext`() {
        val store = MemoryBlobStore()
        val secretKey = key()
        val vault = CredentialVault("org.yaqmc.android", store, CredentialKeyProvider { secretKey })

        vault.put("qqmusic", "sensitive session")

        assertEquals("sensitive session", vault.get("qqmusic"))
        assertNotEquals("sensitive session", store.values["qqmusic"])
        assertFalse(store.values.getValue("qqmusic").contains("sensitive session"))
    }

    @Test
    fun `malformed and tampered envelopes are rejected without deleting ciphertext`() {
        val store = MemoryBlobStore()
        val secretKey = key()
        val vault = CredentialVault("org.yaqmc.android", store, CredentialKeyProvider { secretKey })
        store.values["malformed"] = "not-an-envelope"
        vault.put("tampered", "session")
        store.values["tampered"] = store.values.getValue("tampered").dropLast(2) + "AA"

        val malformed = assertFailsWith<IllegalStateException> { vault.get("malformed") }
        val tampered = assertFailsWith<IllegalStateException> { vault.get("tampered") }

        assertTrue(malformed.message.orEmpty().contains("sign-in may be required"))
        assertTrue(tampered.message.orEmpty().contains("sign-in may be required"))
        assertNotNull(store.values["malformed"])
        assertNotNull(store.values["tampered"])
    }

    @Test
    fun `recreated key and mismatched application AAD reject but preserve the credential`() {
        val originalKey = key()
        val rotatedKey = key()
        val keySlot = arrayOf<SecretKey>(originalKey)
        val store = MemoryBlobStore()
        val vault = CredentialVault("org.yaqmc.android", store, CredentialKeyProvider { keySlot[0] })
        vault.put("rotated", "session")
        keySlot[0] = rotatedKey

        assertFailsWith<IllegalStateException> { vault.get("rotated") }
        assertNotNull(store.values["rotated"])

        keySlot[0] = originalKey
        vault.put("aad", "session")
        val otherApp = CredentialVault("org.example.other", store, CredentialKeyProvider { originalKey })
        assertFailsWith<IllegalStateException> { otherApp.get("aad") }
        assertNotNull(store.values["aad"])
    }

    @Test
    fun `transient key failure preserves ciphertext and a later read can recover`() {
        val store = MemoryBlobStore()
        val secretKey = key()
        var keyAvailable = true
        val vault = CredentialVault(
            "org.yaqmc.android",
            store,
            CredentialKeyProvider {
                check(keyAvailable) { "keystore temporarily unavailable" }
                secretKey
            },
        )
        vault.put("qqmusic", "sensitive session")

        keyAvailable = false
        assertFailsWith<IllegalStateException> { vault.get("qqmusic") }
        assertNotNull(store.values["qqmusic"])

        keyAvailable = true
        assertEquals("sensitive session", vault.get("qqmusic"))
    }

    @Test
    fun `missing and explicitly removed credentials return no secret`() {
        val store = MemoryBlobStore()
        val secretKey = key()
        val vault = CredentialVault("org.yaqmc.android", store, CredentialKeyProvider { secretKey })
        assertNull(vault.get("missing"))
        vault.put("present", "session")
        vault.remove("present")
        assertNull(vault.get("present"))
    }

    private class MemoryBlobStore : CredentialBlobStore {
        val values = mutableMapOf<String, String>()

        override fun read(name: String): String? = values[name]

        override fun write(name: String, value: String): Boolean {
            values[name] = value
            return true
        }

        override fun remove(name: String): Boolean {
            values.remove(name)
            return true
        }
    }

    private fun key(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
}
