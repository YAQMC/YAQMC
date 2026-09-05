package org.yaqmc.android

import kotlin.test.assertEquals
import org.junit.Test

class FrameRatePolicyTest {
    @Test
    fun `legacy policy selects the highest valid supported rate`() {
        assertEquals(120f, highestRefreshRate(floatArrayOf(60f, 120f, 90f)))
    }

    @Test
    fun `legacy policy ignores invalid rates and preserves no preference`() {
        assertEquals(60f, highestRefreshRate(floatArrayOf(Float.NaN, -1f, 0f, 60f)))
        assertEquals(0f, highestRefreshRate(floatArrayOf()))
    }
}
