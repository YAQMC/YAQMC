package org.yaqmc.android.core

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreManagerContractTest {
    @Test
    fun publicListenerAndPrivateNativeCallbacksAreSeparated() {
        val publicMethods = CoreManager.Callback::class.java.declaredMethods.map { it.name }.toSet()
        assertEquals(setOf("onCoreResponse", "onCoreEvent"), publicMethods)

        val nativeMethods = CoreManager::class.java.declaredClasses
            .flatMap { it.declaredMethods.toList() }
            .map { it.name }
            .toSet()
        assertTrue("credentialLoad" in nativeMethods)
        assertTrue("credentialSave" in nativeMethods)
        assertTrue("credentialDelete" in nativeMethods)
        val callbackMethods = CoreManager::class.java.declaredClasses
            .flatMap { it.declaredMethods.toList() }
            .filter { it.name.startsWith("onCore") || it.name.startsWith("credential") }
        assertTrue(callbackMethods.isNotEmpty())
        assertTrue(
            "Rust calls callback-object instance methods through JNI",
            callbackMethods.none { Modifier.isStatic(it.modifiers) },
        )
    }
}
