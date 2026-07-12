package io.github.konijima.commlink.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** What an open subscribe connection tells its owner. */
sealed interface SubscriberEvent {

    /** The socket is open. Every message published from now on arrives on it. */
    data object Connected : SubscriberEvent

    /** A message arrived. */
    data class Received(val message: Message) : SubscriberEvent

    /**
     * A frame arrived that is not a message this app understands. The connection is left
     * open — one frame the app cannot read is not a reason to stop reading the rest — but
     * it is reported rather than dropped, so a server and a client that disagree about the
     * frame say so somewhere.
     */
    data class Undecodable(val frame: String) : SubscriberEvent

    /**
     * The connection is over, and no further event will follow it.
     *
     * [closeCode] is set when the socket had opened and the server closed it: `1008` is
     * how the server refuses a topic it will not serve, and how it drops a subscriber
     * whose token has been revoked. [httpStatus] is set when the handshake itself was
     * refused — `401` for a token the server does not hold. Neither is set when the
     * connection simply failed, which is what a network that went away looks like.
     */
    data class Disconnected(
        val reason: String,
        val closeCode: Int? = null,
        val httpStatus: Int? = null,
    ) : SubscriberEvent
}

/** A connection this client opened. Closing it is idempotent. */
class SubscriberConnection internal constructor(private val socket: WebSocket) {
    fun close() {
        // 1000 is a normal closure: the app is done, not the server misbehaving. A socket
        // that will not take a close — one whose handshake never finished, or that is closed
        // already — is cancelled instead, so this always ends the connection.
        if (!socket.close(NORMAL_CLOSURE, null)) socket.cancel()
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
    }
}

/**
 * Opens the one multiplexed WebSocket a subscriber holds, and reports what happens on it.
 *
 * The client does no reconnecting and keeps no state: it opens a socket, reports its
 * events, and is done when the socket is. Deciding whether and when to open another one is
 * the caller's, which is the service that owns the connection's lifetime.
 *
 * Keepalive needs no code here. The server pings every 45 seconds and drops a subscriber
 * that does not answer; OkHttp replies to a ping with a pong from its own reader thread, so
 * the connection stays alive as long as the socket is readable.
 */
class SubscriberClient(private val http: OkHttpClient = defaultHttpClient()) {

    /**
     * Connect for [subscription], resuming at [since] so a reconnecting subscriber is
     * replayed what it missed. Events are delivered to [onEvent] on OkHttp's reader thread,
     * in order, until a [SubscriberEvent.Disconnected] ends the stream.
     *
     * The token goes on the handshake as `Authorization: Bearer …`, never in the URL: a
     * query string is what proxies and access logs write down.
     *
     * @throws IllegalArgumentException naming the rule, if the subscription is not one the
     *   server would accept.
     */
    fun open(
        subscription: Subscription,
        since: Long? = null,
        onEvent: (SubscriberEvent) -> Unit,
    ): SubscriberConnection {
        val request = Request.Builder()
            .url(handshakeUrl(subscription.url(since)))
            .header("Authorization", "Bearer ${subscription.token}")
            .build()

        val socket = http.newWebSocket(request, Listener(onEvent))
        return SubscriberConnection(socket)
    }

    private class Listener(private val onEvent: (SubscriberEvent) -> Unit) : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            onEvent(SubscriberEvent.Connected)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = Message.fromFrame(text)
            onEvent(
                if (message == null) SubscriberEvent.Undecodable(text)
                else SubscriberEvent.Received(message),
            )
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Answer the server's close with our own, so the socket ends the way the
            // protocol says rather than by timing out.
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onEvent(
                SubscriberEvent.Disconnected(
                    reason = reason.ifEmpty { "the server closed the connection" },
                    closeCode = code,
                ),
            )
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            onEvent(
                SubscriberEvent.Disconnected(
                    reason = t.message ?: t.javaClass.simpleName,
                    httpStatus = response?.code,
                ),
            )
        }
    }

    private companion object {
        /**
         * `ws://` and `wss://` are what a subscribe URL is written with; OkHttp asks for the
         * HTTP scheme the handshake actually travels over, and upgrades it itself.
         */
        fun handshakeUrl(url: String): String = when {
            url.startsWith("wss://") -> "https://" + url.removePrefix("wss://")
            url.startsWith("ws://") -> "http://" + url.removePrefix("ws://")
            else -> url
        }

        /**
         * A read timeout would cut a healthy connection: a subscribe socket is silent for
         * as long as nothing is published on its topics, which may be days. Liveness is the
         * server's ping instead, so the read side waits indefinitely.
         */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }
}
