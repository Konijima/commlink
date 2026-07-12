package io.github.konijima.commlink.net

/**
 * Everything needed to open one subscribe connection: which server, with which token, for
 * which topics.
 *
 * All the topics ride on a single multiplexed socket — the server takes up to 50 of them
 * on one connection and names the topic in every frame — so a subscription is one
 * connection however many topics it carries, not one per topic.
 */
data class Subscription(
    val server: String,
    val token: String,
    val topics: List<String>,
) {
    /**
     * The URL to connect to, resuming at [since] (a unix second) when the caller has seen
     * messages before and wants what it missed while it was away.
     *
     * @throws IllegalArgumentException naming the rule the server or the topics break.
     */
    fun url(since: Long? = null): String = SubscribeUrl.of(server, topics, since)

    /** Whether this describes a connection the server would accept. */
    fun isValid(): Boolean =
        token.isNotEmpty() &&
            try {
                url()
                true
            } catch (e: IllegalArgumentException) {
                false
            }
}
