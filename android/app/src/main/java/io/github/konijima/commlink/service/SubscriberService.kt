package io.github.konijima.commlink.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.konijima.commlink.net.SubscriberClient
import io.github.konijima.commlink.net.SubscriberConnection
import io.github.konijima.commlink.net.SubscriberEvent
import io.github.konijima.commlink.net.Subscription

/**
 * Holds the app's one connection to the server: a single multiplexed WebSocket carrying
 * every subscribed topic, for as long as the app is installed and configured.
 *
 * It is a foreground service because that is the only way Android lets an app keep a socket
 * open when the user is not looking at it — a background process is frozen, and with it the
 * connection that push notifications arrive on. The price is a persistent notification,
 * which is posted on a low-importance channel so it is silent and sits at the bottom of the
 * shade.
 *
 * It is `START_STICKY` because the connection is the whole point of the app: if the system
 * kills the service to reclaim memory, it should come back. The restart arrives with a null
 * intent, so the subscription is read back from [SubscriptionStore] rather than from the
 * intent that started it the first time.
 *
 * The service does not reconnect yet — a dropped connection is reported in the notification
 * and stays dropped. Backoff, network-change callbacks and replaying what was missed are
 * the next items on the roadmap.
 */
class SubscriberService : Service() {

    private val client = SubscriberClient()
    private val main = Handler(Looper.getMainLooper())

    private lateinit var store: SubscriptionStore
    private var connection: SubscriberConnection? = null
    private var subscription: Subscription? = null

    /**
     * What the connection is doing, as the notification last reported it. The service holds
     * this rather than inferring it from what just happened, because a start is not evidence
     * of a connection: a start carrying the subscription the service already holds opens
     * nothing, so no [SubscriberEvent.Connected] follows it, and a notification repainted
     * "Connecting…" on the way past would stay there over a connection that is up and
     * delivering. Nothing has been attempted yet, so it begins disconnected.
     */
    private var state = ConnectionState.DISCONNECTED

    /**
     * Which connection the service is listening to. A closed socket still reports its own
     * close, and that report arrives after the replacement is already up — so an event is
     * matched against the connection it came from and dropped if that one has been replaced.
     * Without this, reconnecting would end with the old socket's goodbye overwriting the new
     * socket's "connected", and the app would say it was down while it was up.
     */
    private var generation = 0

    override fun onCreate() {
        super.onCreate()
        store = SubscriptionStore(this)
        createNotificationChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        // A null intent is the restart START_STICKY asked for, and carries no configuration:
        // what the service was last started with is what it comes back with.
        val requested = intent?.let(::subscriptionFrom) ?: store.load()

        // A start opens a socket only if it asks for something the service is not already
        // holding. Decide that before the notification, so the notification reports what this
        // start is about to do rather than what a start usually does: a start that reconnects
        // is connecting, and a start that finds its connection already open leaves the state
        // that connection reached alone.
        val willConnect = requested != null && requested.isValid() &&
            (requested != subscription || connection == null)
        if (willConnect) state = ConnectionState.CONNECTING

        // The notification goes up first, whatever happens next. A service started with
        // `startForegroundService` has a few seconds to show one or the system kills the
        // process — including on the paths below, which stop the service straight away.
        startForeground(
            STATUS_NOTIFICATION_ID,
            statusNotification(this, state, (requested ?: subscription)?.topics.orEmpty()),
        )

        if (requested == null || !requested.isValid()) {
            // Nothing to connect to. A foreground service with no connection is a
            // notification and nothing else, so stop rather than hold one up. Stopping
            // takes the notification down with it.
            Log.w(TAG, "no valid subscription to connect with; stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        if (willConnect) {
            store.save(requested)
            connect(requested)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        // Step past the connection being closed, so its own goodbye does not come back to a
        // service that is on its way out.
        generation++
        connection?.close()
        connection = null
        super.onDestroy()
    }

    /** Nothing binds to this service; it is started and stopped, and it talks by notification. */
    override fun onBind(intent: Intent?): IBinder? = null

    private fun connect(requested: Subscription) {
        connection?.close()
        subscription = requested

        val mine = ++generation
        connection = client.open(requested) { event ->
            // OkHttp reports on its own reader thread; the service's state is the main
            // thread's, so events cross over before anything is touched — and a late event
            // from a connection that has since been replaced is dropped there.
            main.post { if (mine == generation) onEvent(event) }
        }
    }

    private fun onEvent(event: SubscriberEvent) {
        when (event) {
            is SubscriberEvent.Connected -> showStatus(ConnectionState.CONNECTED)

            is SubscriberEvent.Received ->
                post(messageNotificationId(event.message), messageNotification(this, event.message))

            is SubscriberEvent.Undecodable ->
                Log.w(TAG, "ignoring a frame that is not a message this app understands")

            is SubscriberEvent.Disconnected -> {
                Log.w(TAG, "disconnected: ${event.reason}")
                connection = null
                showStatus(ConnectionState.DISCONNECTED)
            }
        }
    }

    private fun showStatus(state: ConnectionState) {
        this.state = state
        post(STATUS_NOTIFICATION_ID, statusNotification(this, state, subscription?.topics.orEmpty()))
    }

    /**
     * Posting is conditional on the user letting the app notify at all: from Android 13 that
     * is a runtime permission, and `areNotificationsEnabled` is false until it is granted (and
     * on any version, if the user turned notifications off). The service keeps its connection
     * either way — the notification is how a message is *shown*, not how it is received — and
     * the messages it could not show are the ones the first-launch permission prompt exists to
     * unlock.
     */
    @SuppressLint("MissingPermission") // areNotificationsEnabled() is that check, on every version.
    private fun post(id: Int, notification: Notification) {
        if (notifications.areNotificationsEnabled()) notifications.notify(id, notification)
    }

    private val notifications: NotificationManagerCompat
        get() = NotificationManagerCompat.from(this)

    companion object {
        private const val TAG = "SubscriberService"

        /** Stop the connection and take the service down. */
        const val ACTION_STOP = "io.github.konijima.commlink.STOP"

        private const val EXTRA_SERVER = "server"
        private const val EXTRA_TOKEN = "token"
        private const val EXTRA_TOPICS = "topics"

        /** The intent that starts the service subscribing to [subscription]. */
        fun startIntent(context: Context, subscription: Subscription): Intent =
            Intent(context, SubscriberService::class.java)
                .putExtra(EXTRA_SERVER, subscription.server)
                .putExtra(EXTRA_TOKEN, subscription.token)
                .putExtra(EXTRA_TOPICS, subscription.topics.joinToString(","))

        /** The intent that stops it. */
        fun stopIntent(context: Context): Intent =
            Intent(context, SubscriberService::class.java).setAction(ACTION_STOP)

        /**
         * Start the service subscribing to [subscription]. A running service is handed the
         * new configuration and reconnects with it.
         */
        fun start(context: Context, subscription: Subscription) {
            ContextCompat.startForegroundService(context, startIntent(context, subscription))
        }

        fun stop(context: Context) {
            context.startService(stopIntent(context))
        }

        /** The subscription [intent] carries, or `null` if it does not carry a whole one. */
        fun subscriptionFrom(intent: Intent): Subscription? {
            val server = intent.getStringExtra(EXTRA_SERVER) ?: return null
            val token = intent.getStringExtra(EXTRA_TOKEN) ?: return null
            val topics = intent.getStringExtra(EXTRA_TOPICS)
                ?.split(",")
                ?.map(String::trim)
                ?.filter(String::isNotEmpty)
                .orEmpty()
            if (topics.isEmpty()) return null
            return Subscription(server = server, token = token, topics = topics)
        }
    }
}
