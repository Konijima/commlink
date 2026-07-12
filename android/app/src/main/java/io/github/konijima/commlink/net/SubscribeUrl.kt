package io.github.konijima.commlink.net

import java.net.URI
import java.net.URISyntaxException

/**
 * Builds the URL the subscriber connects to: one multiplexed WebSocket carrying every
 * topic the app is subscribed to, optionally replaying what it missed while it was away.
 *
 * The rules below are the server's, restated here so a bad subscription is refused on the
 * device — where the reason can be shown — rather than at the far end of a socket that
 * closes with a code. They are the server's exactly: any topic this builds a URL for is a
 * topic the server accepts, so a refusal here is never the client being stricter than the
 * thing it is talking to.
 */
object SubscribeUrl {

    /** The server subscribes to at most this many topics on one connection. */
    const val MAX_TOPICS = 50

    /** A topic name is 1-64 characters of this alphabet. */
    const val MAX_TOPIC_LENGTH = 64

    /** The server serves `/healthz` itself, so no topic may be called that. */
    private val RESERVED_TOPICS = setOf("healthz")

    private val TOPIC_PATTERN = Regex("^[A-Za-z0-9_-]{1,$MAX_TOPIC_LENGTH}$")

    const val TOPIC_RULE =
        "topic must be 1-$MAX_TOPIC_LENGTH characters of A-Z, a-z, 0-9, hyphen or underscore"
    const val TOPIC_COUNT_RULE = "subscribe to between 1 and $MAX_TOPICS topics"
    const val SERVER_RULE = "server must be an http, https, ws or wss URL with a host"
    const val SINCE_RULE = "since must be a whole number of seconds, not before the epoch"

    /**
     * The WebSocket URL for [topics] on [server], e.g.
     * `https://push.example.com` + `[alerts, builds]` -> `wss://push.example.com/alerts,builds/ws`.
     *
     * [server] may be written with either the http or the ws scheme — an operator copies the
     * one from their browser, so `https://…` is what they have — and may carry a path, for a
     * server mounted under one by a reverse proxy. [since] asks for a replay of everything
     * published from that unix second onward, which is how a reconnecting subscriber picks up
     * what it missed; the bound is inclusive, so the caller must expect one message twice and
     * de-duplicate on its id.
     *
     * The auth token is not in the URL: it rides on the handshake as `Authorization: Bearer …`,
     * because a query string is what proxies and access logs write down.
     *
     * @throws IllegalArgumentException naming the rule that was broken.
     */
    fun of(server: String, topics: List<String>, since: Long? = null): String {
        require(topics.isNotEmpty() && topics.size <= MAX_TOPICS) { TOPIC_COUNT_RULE }
        topics.forEach(::requireValidTopic)
        require(since == null || since >= 0) { SINCE_RULE }

        val base = webSocketBase(server)
        val query = if (since == null) "" else "?since=$since"
        return "$base/${topics.joinToString(",")}/ws$query"
    }

    /** Whether [topic] is a name the server would accept. */
    fun isValidTopic(topic: String): Boolean =
        TOPIC_PATTERN.matches(topic) && topic !in RESERVED_TOPICS

    private fun requireValidTopic(topic: String) {
        require(TOPIC_PATTERN.matches(topic)) { TOPIC_RULE }
        require(topic !in RESERVED_TOPICS) { "topic \"$topic\" is reserved by the server" }
    }

    /**
     * [server] as a WebSocket origin with no trailing slash: the scheme mapped to its socket
     * equivalent, the authority kept, and any path kept as the prefix the routes hang off.
     */
    private fun webSocketBase(server: String): String {
        val uri = try {
            URI(server.trim())
        } catch (e: URISyntaxException) {
            throw IllegalArgumentException(SERVER_RULE, e)
        }

        val scheme = when (uri.scheme?.lowercase()) {
            "http", "ws" -> "ws"
            "https", "wss" -> "wss"
            else -> throw IllegalArgumentException(SERVER_RULE)
        }
        val authority = uri.authority
        require(!authority.isNullOrEmpty()) { SERVER_RULE }
        // A query or fragment on the base would land in front of `?since=`, where it would
        // be neither honoured nor visible. Refuse it rather than drop it silently.
        require(uri.query == null && uri.fragment == null) { SERVER_RULE }

        val path = uri.path.orEmpty().trimEnd('/')
        return "$scheme://$authority$path"
    }
}
