package io.github.konijima.commlink.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One published message, exactly as the server streams it: a JSON frame per message on
 * the subscribe socket.
 *
 * [title] is absent when the publisher sent none, and [message] is empty when it sent only
 * a title — the server requires one or the other, never neither, so a message always has
 * something to show. [timestamp] is whole seconds since the Unix epoch, which is also the
 * unit `?since=` replays from, so the last one seen is what a reconnecting subscriber asks
 * to resume at.
 */
@Serializable
data class Message(
    val id: String,
    val topic: String,
    val title: String? = null,
    val message: String,
    val priority: Int,
    val tags: List<String> = emptyList(),
    val timestamp: Long,
) {
    companion object {
        /**
         * Unknown fields are ignored rather than refused: a server newer than the app may
         * add a field to the frame, and an app that rejected the whole message over one it
         * does not use would stop delivering notifications on a server upgrade.
         */
        private val JSON = Json { ignoreUnknownKeys = true }

        /** [frame] decoded, or `null` if it is not a message this app understands. */
        fun fromFrame(frame: String): Message? =
            try {
                JSON.decodeFromString(serializer(), frame)
            } catch (e: IllegalArgumentException) {
                // kotlinx.serialization reports both malformed JSON and a frame missing a
                // required field as subclasses of this. Either way the frame is not a
                // message, and one bad frame must not take the connection down with it.
                null
            }
    }
}
