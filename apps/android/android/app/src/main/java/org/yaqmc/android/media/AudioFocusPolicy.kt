package org.yaqmc.android.media

internal enum class FocusChange {
    GAIN,
    LOSS,
    LOSS_TRANSIENT,
    LOSS_TRANSIENT_CAN_DUCK,
}

internal enum class FocusAction {
    NONE,
    PAUSE,
    RESUME,
}

/** Pure policy state; Android callbacks only translate constants into these events. */
internal class AudioFocusPolicy {
    private var userPaused = false
    private var transientPause = false
    private var resumable = true

    fun onUserPlay() {
        userPaused = false
        resumable = true
    }

    fun onUserPause() {
        userPaused = true
        transientPause = false
    }

    fun onFocusChange(change: FocusChange, isPlaying: Boolean): FocusAction = when (change) {
        FocusChange.LOSS -> {
            resumable = false
            transientPause = false
            if (isPlaying) FocusAction.PAUSE else FocusAction.NONE
        }
        FocusChange.LOSS_TRANSIENT,
        FocusChange.LOSS_TRANSIENT_CAN_DUCK,
        -> {
            if (isPlaying) transientPause = true
            if (isPlaying) FocusAction.PAUSE else FocusAction.NONE
        }
        FocusChange.GAIN -> {
            val resume = transientPause && resumable && !userPaused
            transientPause = false
            if (resume) FocusAction.RESUME else FocusAction.NONE
        }
    }

    fun onBecomingNoisy(isPlaying: Boolean): FocusAction {
        resumable = false
        transientPause = false
        return if (isPlaying) FocusAction.PAUSE else FocusAction.NONE
    }
}
