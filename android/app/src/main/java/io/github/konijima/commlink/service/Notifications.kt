package io.github.konijima.commlink.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.github.konijima.commlink.R
import io.github.konijima.commlink.net.Message

/** The channel carrying the service's own "I am connected" notification. */
const val CHANNEL_STATUS = "status"

/**
 * The channel carrying delivered messages. There will be one channel per priority, so that
 * sound and vibration are configurable per priority in the system settings; until then every
 * message lands here.
 */
const val CHANNEL_MESSAGES = "messages"

/** The id of the one notification the foreground service keeps posted for its lifetime. */
const val STATUS_NOTIFICATION_ID = 1

/** What the subscriber connection is doing, as the persistent notification reports it. */
enum class ConnectionState { CONNECTING, CONNECTED, DISCONNECTED }

/**
 * Declares the channels the app posts on. Safe to call again: creating a channel that
 * exists updates its name, and never overrides what the user has since chosen for it.
 */
fun createNotificationChannels(context: Context) {
    val manager = NotificationManagerCompat.from(context)

    // Low importance: the connection notification is a status line, not news. It has to
    // exist — a foreground service must show one — so it must not make a sound.
    val status = NotificationChannel(
        CHANNEL_STATUS,
        context.getString(R.string.channel_status),
        NotificationManager.IMPORTANCE_LOW,
    ).apply {
        description = context.getString(R.string.channel_status_description)
        setShowBadge(false)
    }

    val messages = NotificationChannel(
        CHANNEL_MESSAGES,
        context.getString(R.string.channel_messages),
        NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
        description = context.getString(R.string.channel_messages_description)
    }

    manager.createNotificationChannels(listOf(status, messages))
}

/**
 * The persistent notification the foreground service shows for as long as it is running.
 * It is ongoing (the user cannot swipe the service away) and silent, and it says which
 * topics are subscribed, so the notification that is the price of a background connection
 * at least reports what that connection is for.
 */
fun statusNotification(context: Context, state: ConnectionState, topics: List<String>) =
    NotificationCompat.Builder(context, CHANNEL_STATUS)
        .setSmallIcon(R.drawable.ic_status)
        .setContentTitle(
            context.getString(
                when (state) {
                    ConnectionState.CONNECTING -> R.string.status_connecting
                    ConnectionState.CONNECTED -> R.string.status_connected
                    ConnectionState.DISCONNECTED -> R.string.status_disconnected
                },
            ),
        )
        .setContentText(topics.joinToString(", "))
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .build()

/**
 * A delivered message as a notification. The title is the publisher's, falling back to the
 * topic when it sent none — the server guarantees a message has a title or a body, so there
 * is always something to show — and the body is the message text, verbatim.
 */
fun messageNotification(context: Context, message: Message) =
    NotificationCompat.Builder(context, CHANNEL_MESSAGES)
        .setSmallIcon(R.drawable.ic_status)
        .setContentTitle(message.title ?: message.topic)
        .setContentText(message.message)
        .setStyle(NotificationCompat.BigTextStyle().bigText(message.message))
        .setSubText(message.topic)
        .setWhen(message.timestamp * 1000)
        .setShowWhen(true)
        .setAutoCancel(true)
        .build()

/**
 * The notification id for [message]. It is derived from the message's own id, so a message
 * delivered twice — which a replaying reconnect does, since `?since=` is inclusive to the
 * second — updates the notification it already posted rather than posting a second copy.
 *
 * [STATUS_NOTIFICATION_ID] is stepped over rather than risked: a message that happened to
 * hash to it would replace the service's own notification, and a foreground service whose
 * notification is gone is a service the system kills.
 */
fun messageNotificationId(message: Message): Int =
    message.id.hashCode().let { if (it == STATUS_NOTIFICATION_ID) it + 1 else it }
