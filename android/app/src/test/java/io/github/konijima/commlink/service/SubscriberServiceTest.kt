package io.github.konijima.commlink.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.os.Looper
import androidx.core.app.NotificationCompat
import io.github.konijima.commlink.net.Subscription
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import java.util.concurrent.TimeUnit

/**
 * The service against a real WebSocket server on the loopback interface: the whole path a
 * message travels, from the intent that starts the service through the socket it opens to
 * the notification the message becomes.
 */
@RunWith(RobolectricTestRunner::class)
class SubscriberServiceTest {

    private lateinit var server: MockWebServer
    private val context: Context get() = RuntimeEnvironment.getApplication()

    private val notificationManager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun subscription(vararg topics: String) = Subscription(
        server = "http://${server.hostName}:${server.port}",
        token = "a-token",
        topics = topics.toList().ifEmpty { listOf("alerts") },
    )

    /**
     * A server that runs [onOpen] once a subscriber's socket is up, and closes back when it is
     * closed — waiting [echoCloseAfterMillis] first, to place its goodbye at a known point in
     * the order of events.
     */
    private fun serving(echoCloseAfterMillis: Long = 0, onOpen: (WebSocket) -> Unit) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)

                // A close is a handshake, and the peer echoes it — which is what makes a
                // replaced connection report its own close *after* the new one is up.
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    Thread.sleep(echoCloseAfterMillis)
                    webSocket.close(code, null)
                }
            }),
        )
    }

    private fun startService(subscription: Subscription?): ServiceController<SubscriberService> {
        val intent = if (subscription == null) {
            android.content.Intent(context, SubscriberService::class.java)
        } else {
            SubscriberService.startIntent(context, subscription)
        }
        return Robolectric.buildService(SubscriberService::class.java, intent).create().startCommand(0, 0)
    }

    /**
     * Drains the main looper until [condition] holds. The socket runs on OkHttp's own thread
     * and posts to the main thread, which Robolectric only advances when told to.
     */
    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what")
    }

    @Test
    fun `holds its connection open, so the system restarts it if it is killed`() {
        serving { }

        val service = startService(subscription("alerts")).get()

        assertEquals(
            Service.START_STICKY,
            service.onStartCommand(SubscriberService.startIntent(context, subscription("alerts")), 0, 0),
        )
    }

    @Test
    fun `runs in the foreground behind a silent, ongoing notification`() {
        serving { }

        val service = startService(subscription("alerts", "builds")).get()

        val foreground = shadowOf(service).lastForegroundNotification
        assertNotNull("the service must post a notification to run in the foreground", foreground)
        assertEquals(STATUS_NOTIFICATION_ID, shadowOf(service).lastForegroundNotificationId)
        assertEquals(CHANNEL_STATUS, foreground.channelId)
        assertTrue("the user must not be able to swipe the connection away", foreground.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)

        // Low importance: a connection notification is a status line, not news.
        val channel = notificationManager.getNotificationChannel(CHANNEL_STATUS)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
    }

    @Test
    fun `says it is connected once the socket is open`() {
        serving { }

        startService(subscription("alerts"))

        waitFor("the notification to say the connection is up") {
            statusText() == context.getString(io.github.konijima.commlink.R.string.status_connected)
        }
    }

    @Test
    fun `turns a published message into a notification`() {
        serving { it.send(FRAME) }

        startService(subscription("alerts"))

        waitFor("the message to be posted") { messageNotification() != null }

        val notification = messageNotification()!!
        assertEquals("Disk full", notification.extras.getString(NotificationCompat.EXTRA_TITLE))
        assertEquals("/ is at 98%", notification.extras.getString(NotificationCompat.EXTRA_TEXT))
        assertEquals(CHANNEL_MESSAGES, notification.channelId)
    }

    @Test
    fun `posts a message replayed twice only once`() {
        // `?since=` is inclusive to the second, so a reconnecting subscriber is handed a
        // message it already has. It must update the notification, not stack a second copy.
        serving {
            it.send(FRAME)
            it.send(FRAME)
        }

        startService(subscription("alerts"))

        waitFor("the message to be posted") { messageNotification() != null }
        // Drain whatever else the socket has to say, so a second notification would land.
        waitFor("the socket to go quiet") { server.requestCount == 1 }

        assertEquals(
            "the status notification and one message, not two messages",
            2,
            shadowOf(notificationManager).size(),
        )
    }

    @Test
    fun `says it is not connected when the server refuses the token`() {
        server.enqueue(MockResponse().setResponseCode(401))

        startService(subscription("alerts"))

        waitFor("the notification to say the connection is down") {
            statusText() == context.getString(io.github.konijima.commlink.R.string.status_disconnected)
        }
    }

    @Test
    fun `stops rather than hold a notification up for nothing when it has no subscription`() {
        val controller = startService(null)

        // It still posted the foreground notification first: a service started with
        // `startForegroundService` that does not is killed by the system.
        assertNotNull(shadowOf(controller.get()).lastForegroundNotification)
        assertTrue("the service must stop itself", shadowOf(controller.get()).isStoppedBySelf)
        assertEquals(
            Service.START_NOT_STICKY,
            controller.get().onStartCommand(android.content.Intent(context, SubscriberService::class.java), 0, 0),
        )
    }

    @Test
    fun `comes back on the subscription it was last started with`() {
        // START_STICKY restarts the service with a null intent. What it was configured with
        // is what it must come back with, or the restart is pointless.
        serving { }
        serving { }

        startService(subscription("alerts"))
        val restarted = Robolectric.buildService(SubscriberService::class.java).create().get()

        assertEquals(Service.START_STICKY, restarted.onStartCommand(null, 0, 0))
        waitFor("the restarted service to connect") { server.requestCount == 2 }
        assertEquals("/alerts/ws", server.takeRequest(1, TimeUnit.SECONDS)!!.path)
        assertEquals("/alerts/ws", server.takeRequest(1, TimeUnit.SECONDS)!!.path)
    }

    @Test
    fun `does not let a replaced connection report the new one as down`() {
        // Re-subscribing closes the open socket and opens another. The closed one still says
        // goodbye, and that arrives *after* the new socket is up — so an unguarded service
        // ends up showing "not connected" while it is connected. The first server is made
        // slow to answer the close, which is where a real one's goodbye lands anyway: behind
        // a round trip the new connection does not have to wait for.
        serving(echoCloseAfterMillis = 500) { }
        serving { }

        val controller = startService(subscription("alerts"))
        waitFor("the first connection") { server.requestCount == 1 }

        controller.get().onStartCommand(SubscriberService.startIntent(context, subscription("builds")), 0, 0)

        waitFor("the second connection to report itself up") { statusText() == connected() }
        // And it stays up: the old socket's goodbye lands somewhere in here, and must not
        // be mistaken for this connection's.
        settle()
        assertEquals(connected(), statusText())
        assertEquals("builds", statusTopics())
    }

    @Test
    fun `stops when it is told to`() {
        serving { }
        val controller = startService(subscription("alerts"))

        val result = controller.get().onStartCommand(SubscriberService.stopIntent(context), 0, 0)

        assertEquals(Service.START_NOT_STICKY, result)
        assertTrue(shadowOf(controller.get()).isStoppedBySelf)
    }

    @Test
    fun `reads a whole subscription off an intent, and nothing less`() {
        val intent = SubscriberService.startIntent(context, subscription("alerts", "builds"))

        assertEquals(listOf("alerts", "builds"), SubscriberService.subscriptionFrom(intent)!!.topics)
        assertEquals("a-token", SubscriberService.subscriptionFrom(intent)!!.token)

        // Half a subscription is no subscription: there is nothing sensible to connect with.
        assertNull(
            SubscriberService.subscriptionFrom(
                android.content.Intent().putExtra("server", "https://push.example.com"),
            ),
        )
        assertNull(SubscriberService.subscriptionFrom(android.content.Intent()))
    }

    /** Runs the main thread on for a while, so an event still in flight gets its chance to land. */
    private fun settle() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
    }

    private fun connected() = context.getString(io.github.konijima.commlink.R.string.status_connected)

    private fun statusText(): String? =
        shadowOf(notificationManager).getNotification(STATUS_NOTIFICATION_ID)
            ?.extras?.getString(NotificationCompat.EXTRA_TITLE)

    private fun statusTopics(): String? =
        shadowOf(notificationManager).getNotification(STATUS_NOTIFICATION_ID)
            ?.extras?.getString(NotificationCompat.EXTRA_TEXT)

    private fun messageNotification() =
        shadowOf(notificationManager).allNotifications.firstOrNull { it.channelId == CHANNEL_MESSAGES }

    private companion object {
        const val FRAME =
            """{"id":"1","topic":"alerts","title":"Disk full","message":"/ is at 98%","priority":5,"tags":["ops"],"timestamp":1752278400}"""
    }
}
