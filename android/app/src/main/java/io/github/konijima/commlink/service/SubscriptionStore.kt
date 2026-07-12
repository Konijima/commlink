package io.github.konijima.commlink.service

import android.content.Context
import io.github.konijima.commlink.net.Subscription

/**
 * Remembers the subscription the service was last started with.
 *
 * The service is `START_STICKY`, so the system restarts it after killing it for memory —
 * and hands it a *null* intent when it does. Without somewhere to read the configuration
 * back from, that restart would bring the service up with nothing to connect to, which is
 * the one thing `START_STICKY` exists to prevent. The same store is what a boot receiver
 * will read to bring the connection back after a reboot.
 *
 * The token is kept in plain preferences, which are private to the app. That is the same
 * protection the app's own files have, and this is a sideloaded app holding a token for a
 * server its owner runs; an attacker who can read another app's private storage has already
 * won more than this token.
 */
class SubscriptionStore(context: Context) {

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** The subscription last saved, or `null` if none has been. */
    fun load(): Subscription? {
        val server = preferences.getString(KEY_SERVER, null) ?: return null
        val token = preferences.getString(KEY_TOKEN, null) ?: return null
        val topics = preferences.getString(KEY_TOPICS, null)?.split(",").orEmpty()
        if (topics.isEmpty()) return null
        return Subscription(server = server, token = token, topics = topics)
    }

    fun save(subscription: Subscription) {
        preferences.edit()
            .putString(KEY_SERVER, subscription.server)
            .putString(KEY_TOKEN, subscription.token)
            .putString(KEY_TOPICS, subscription.topics.joinToString(","))
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private companion object {
        const val FILE = "subscription"
        const val KEY_SERVER = "server"
        const val KEY_TOKEN = "token"
        const val KEY_TOPICS = "topics"
    }
}
