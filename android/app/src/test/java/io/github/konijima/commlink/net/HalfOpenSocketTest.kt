package io.github.konijima.commlink.net

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The connection that died quietly: the far end is gone, and nothing crosses the wire to say
 * so. It is what the phone is left holding when it moves from Wi-Fi to mobile data, or when a
 * NAT forgets the flow while it sleeps — the socket is half-open, and reading it reports
 * nothing forever, because a dead peer sends no data and no error either.
 *
 * Only a write finds out. The client pings on its own cadence for exactly this, so the app
 * learns the connection is gone rather than going on showing "Connected" while delivering
 * nothing.
 *
 * A stub cannot be silent enough to test this: [MockWebServer]'s WebSocket is a real one, and
 * a real WebSocket answers a ping with a pong from its reader thread whether it is asked to or
 * not. So the dead peer here is a raw socket that performs the upgrade handshake by hand and
 * then never speaks again — which is precisely what the app is left talking to.
 */
class HalfOpenSocketTest {

    private val events = LinkedBlockingQueue<SubscriberEvent>()
    private var peer: SilentPeer? = null
    private var mock: MockWebServer? = null

    @After
    fun stop() {
        peer?.close()
        mock?.shutdown()
    }

    private fun nextEvent(): SubscriberEvent =
        requireNotNull(events.poll(10, TimeUnit.SECONDS)) { "the client reported no event" }

    @Test
    fun `reports a connection whose peer stopped answering`() {
        val dead = SilentPeer().also { peer = it }
        val client = SubscriberClient(SubscriberClient.defaultHttpClient(PING_INTERVAL_MS))

        client.open(dead.subscription()) { events.add(it) }

        // The socket opens and looks healthy: the handshake completed, and this is the state
        // the app used to stay in indefinitely.
        assertEquals(SubscriberEvent.Connected, nextEvent())

        // Nothing arrives from the peer — not a message, not a close, not an error. The only
        // thing that can end this connection is the ping the client sends into it going
        // unanswered, which is what the next event proves happened.
        val disconnected = nextEvent() as SubscriberEvent.Disconnected

        // A failure, not a close: the peer never said goodbye, and there was no handshake to
        // refuse — it simply stopped being there.
        assertNull(disconnected.closeCode)
        assertNull(disconnected.httpStatus)
        assertTrue(
            "the disconnect should name the unanswered ping, but said: ${disconnected.reason}",
            disconnected.reason.contains("ping", ignoreCase = true),
        )
        // The peer never closed its end, so the app really did have to find this out itself.
        assertTrue(dead.isStillOpen())
    }

    @Test
    fun `keeps a live connection open across many pings`() {
        // The other half of the rule, and the one a ping interval could plausibly break: a
        // subscribe socket is silent for as long as nothing is published, which may be days,
        // so pinging must not cut a connection that is merely idle. A live peer answers, and
        // the connection outlives several intervals with a message still delivered on it.
        val server = MockWebServer().also { mock = it }
        server.start()

        val sockets = LinkedBlockingQueue<WebSocket>()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    sockets.add(webSocket)
                }
            }),
        )

        val client = SubscriberClient(SubscriberClient.defaultHttpClient(PING_INTERVAL_MS))
        val subscription = Subscription(
            server = "http://${server.hostName}:${server.port}",
            token = "a-token",
            topics = listOf("alerts"),
        )
        client.open(subscription) { events.add(it) }

        assertEquals(SubscriberEvent.Connected, nextEvent())

        val socket = requireNotNull(sockets.poll(10, TimeUnit.SECONDS))
        // Long enough for several pings to fall due, each of which fails the socket if the
        // pong before it did not come back.
        Thread.sleep(PING_INTERVAL_MS * 6)
        socket.send(FRAME)

        // Still connected, and still delivering: the idle time cost the connection nothing.
        val received = nextEvent() as SubscriberEvent.Received
        assertEquals("alerts", received.message.topic)
    }

    @Test
    fun `the shipped client pings on the server's own cadence`() {
        // The interval the app actually runs with, which the tests above have to shorten to
        // run at all. The server pings every 45s; the client mirrors it, so a dead peer is
        // reported within two intervals rather than never.
        val shipped = SubscriberClient.defaultHttpClient()

        assertEquals(45_000, shipped.pingIntervalMillis)
        // And the read side still waits forever, because an idle subscribe socket is normal.
        assertEquals(0, shipped.readTimeoutMillis)
    }

    /**
     * A peer that completes the WebSocket upgrade and then goes silent: it answers no ping,
     * sends no message, and never closes its end. It does not even read what is sent to it —
     * a dead peer does not.
     */
    private class SilentPeer : AutoCloseable {
        private val listener = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        private val upgraded = CountDownLatch(1)

        @Volatile
        private var accepted: Socket? = null

        private val thread = Thread {
            runCatching {
                val socket = listener.accept().also { accepted = it }
                val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.US_ASCII))

                var key: String? = null
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith(KEY_HEADER, ignoreCase = true)) {
                        key = line.substringAfter(':').trim()
                    }
                }

                socket.getOutputStream().apply {
                    write(
                        (
                            "HTTP/1.1 101 Switching Protocols\r\n" +
                                "Upgrade: websocket\r\n" +
                                "Connection: Upgrade\r\n" +
                                "Sec-WebSocket-Accept: ${accept(requireNotNull(key))}\r\n" +
                                "\r\n"
                            ).toByteArray(Charsets.US_ASCII),
                    )
                    flush()
                }
                upgraded.countDown()
                // And that is the last thing this peer ever does.
            }
        }.apply { isDaemon = true; start() }

        fun subscription() = Subscription(
            server = "http://${listener.inetAddress.hostAddress}:${listener.localPort}",
            token = "a-token",
            topics = listOf("alerts"),
        )

        /** True if the peer never closed its end — so the client's ping is what ended the connection. */
        fun isStillOpen(): Boolean {
            check(upgraded.await(10, TimeUnit.SECONDS)) { "the peer never completed the handshake" }
            return accepted?.isClosed == false
        }

        override fun close() {
            thread.interrupt()
            runCatching { accepted?.close() }
            runCatching { listener.close() }
        }

        private companion object {
            const val KEY_HEADER = "Sec-WebSocket-Key:"

            /** RFC 6455's handshake: the client's key, salted, hashed and base64'd back at it. */
            fun accept(key: String): String = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1")
                    .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII)),
            )
        }
    }

    private companion object {
        /** The shipped 45s would make these tests take minutes; the behaviour is the same. */
        const val PING_INTERVAL_MS = 250L

        const val FRAME =
            """{"id":"1","topic":"alerts","title":"Disk full","message":"/ is at 98%","priority":5,"tags":["ops"],"timestamp":1752278400}"""
    }
}
