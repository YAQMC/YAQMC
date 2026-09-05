package org.yaqmc.android.media

import kotlin.test.Test
import kotlin.test.assertEquals

class AudioFocusPolicyTest {
    @Test
    fun `temporary loss resumes only without a user pause`() {
        val policy = AudioFocusPolicy()
        policy.onUserPlay()
        assertEquals(FocusAction.PAUSE, policy.onFocusChange(FocusChange.LOSS_TRANSIENT, true))
        assertEquals(FocusAction.RESUME, policy.onFocusChange(FocusChange.GAIN, false))

        policy.onUserPlay()
        assertEquals(FocusAction.PAUSE, policy.onFocusChange(FocusChange.LOSS_TRANSIENT_CAN_DUCK, true))
        policy.onUserPause()
        assertEquals(FocusAction.NONE, policy.onFocusChange(FocusChange.GAIN, false))
    }

    @Test
    fun `permanent loss and noisy output never auto resume`() {
        val policy = AudioFocusPolicy()
        policy.onUserPlay()
        assertEquals(FocusAction.PAUSE, policy.onFocusChange(FocusChange.LOSS, true))
        assertEquals(FocusAction.NONE, policy.onFocusChange(FocusChange.GAIN, false))

        policy.onUserPlay()
        assertEquals(FocusAction.PAUSE, policy.onBecomingNoisy(true))
        assertEquals(FocusAction.NONE, policy.onFocusChange(FocusChange.GAIN, false))
    }
}
