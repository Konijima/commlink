package io.github.konijima.commlink.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * The app is a dark-theme app: a notification client is read at a glance, often at night,
 * and its own screens should not be the bright thing on the display. A device set to light
 * still gets a legible scheme rather than the dark one inverted badly.
 */
private val DarkColors = darkColorScheme()
private val LightColors = lightColorScheme()

@Composable
fun CommlinkTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
