package io.github.konijima.commlink.net

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The client against a real WebSocket over the loopback interface — a real handshake, real
 * frames, real close codes. Nothing here is a stub of the protocol, so what passes is what
 * the socket does.
 */
class SubscriberClientTest {

    private lateinit var server: MockWebServer
    private val events = LinkedBlockingQueue<SubscriberEvent>()

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
        topics = topics.toList(),
    )

    private fun nextEvent(): SubscriberEvent =
        requireNotNull(events.poll(5, TimeUnit.SECONDS)) { "the client reported no event" }

    /** A server that runs [onOpen] once the socket is up, and closes back when it is closed. */
    private fun serving(onOpen: (WebSocket) -> Unit) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)

                // A close is a handshake: the peer echoes it, and the socket is not over
                // until it does. The real server does this; the stub has to be told to.
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                }
            }),
        )
    }

    @Test
    fun `subscribes to every topic on one socket, with the token on the handshake`() {
        serving { it.send(FRAME) }

        SubscriberClient().open(subscription("alerts", "builds")) { events.add(it) }

        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        // One connection, carrying both topics — not one connection per topic.
        assertEquals("/alerts,builds/ws", request.path)
        // The token rides on the handshake, not in the URL a proxy would log.
        assertEquals("Bearer a-token", request.getHeader("Authorization"))
        assertEquals(SubscriberEvent.Connected, nextEvent())
    }

    @Test
    fun `reports a published message`() {
        serving { it.send(FRAME) }

        SubscriberClient().open(subscription("alerts")) { events.add(it) }

        assertEquals(SubscriberEvent.Connected, nextEvent())
        val received = nextEvent() as SubscriberEvent.Received
        assertEquals("Disk full", received.message.title)
        assertEquals("/ is at 98%", received.message.message)
        assertEquals("alerts", received.message.topic)
    }

    @Test
    fun `asks to be replayed what it missed`() {
        serving { }

        SubscriberClient().open(subscription("alerts"), since = 1752278400) { events.add(it) }

        assertEquals("/alerts/ws?since=1752278400", server.takeRequest(5, TimeUnit.SECONDS)!!.path)
    }

    @Test
    fun `reports a frame it cannot read, and keeps the connection`() {
        serving {
            it.send("{not a message}")
            it.send(FRAME)
        }

        SubscriberClient().open(subscription("alerts")) { events.add(it) }

        assertEquals(SubscriberEvent.Connected, nextEvent())
        assertEquals(SubscriberEvent.Undecodable("{not a message}"), nextEvent())
        // The bad frame did not take the socket down with it: the next message still arrives.
        assertTrue(nextEvent() is SubscriberEvent.Received)
    }

    @Test
    fun `reports the close code the server refused it with`() {
        // 1008 is how the server refuses a topic it will not serve, and how it drops a
        // subscriber whose token has been revoked.
        serving { it.close(1008, "token revoked") }

        SubscriberClient().open(subscription("alerts")) { events.add(it) }

        assertEquals(SubscriberEvent.Connected, nextEvent())
        val disconnected = nextEvent() as SubscriberEvent.Disconnected
        assertEquals(1008, disconnected.closeCode)
        assertEquals("token revoked", disconnected.reason)
        assertNull(disconnected.httpStatus)
    }

    @Test
    fun `reports a handshake the server refused`() {
        // What an unissued or revoked token gets: the socket never opens at all.
        server.enqueue(MockResponse().setResponseCode(401))

        SubscriberClient().open(subscription("alerts")) { events.add(it) }

        val disconnected = nextEvent() as SubscriberEvent.Disconnected
        assertEquals(401, disconnected.httpStatus)
        assertNull(disconnected.closeCode)
    }

    @Test
    fun `closing the connection ends it`() {
        serving { }

        val connection = SubscriberClient().open(subscription("alerts")) { events.add(it) }
        assertEquals(SubscriberEvent.Connected, nextEvent())
        connection.close()

        // 1000: the app is done with the socket, not the server misbehaving.
        assertEquals(1000, (nextEvent() as SubscriberEvent.Disconnected).closeCode)
    }

    @Test
    fun `refuses a subscription the server would refuse`() {
        val refused = runCatching {
            SubscriberClient().open(Subscription("http://localhost", "t", listOf("healthz"))) { }
        }

        assertTrue(refused.exceptionOrNull() is IllegalArgumentException)
    }

    private companion object {
        const val FRAME =
            """{"id":"1","topic":"alerts","title":"Disk full","message":"/ is at 98%","priority":5,"tags":["ops"],"timestamp":1752278400}"""
    }
}
