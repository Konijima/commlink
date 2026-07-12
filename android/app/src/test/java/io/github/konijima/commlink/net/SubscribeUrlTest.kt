package io.github.konijima.commlink.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SubscribeUrlTest {

    @Test
    fun `an https server subscribes over a secure socket`() {
        assertEquals(
            "wss://push.example.com/alerts/ws",
            SubscribeUrl.of("https://push.example.com", listOf("alerts")),
        )
    }

    @Test
    fun `a plain http server subscribes over a plain socket`() {
        assertEquals(
            "ws://127.0.0.1:4500/alerts/ws",
            SubscribeUrl.of("http://127.0.0.1:4500", listOf("alerts")),
        )
    }

    @Test
    fun `a server already written with a socket scheme is left alone`() {
        assertEquals(
            "wss://push.example.com/alerts/ws",
            SubscribeUrl.of("wss://push.example.com", listOf("alerts")),
        )
        assertEquals(
            "ws://push.example.com/alerts/ws",
            SubscribeUrl.of("ws://push.example.com", listOf("alerts")),
        )
    }

    @Test
    fun `a trailing slash does not double up`() {
        assertEquals(
            "wss://push.example.com/alerts/ws",
            SubscribeUrl.of("https://push.example.com///", listOf("alerts")),
        )
    }

    @Test
    fun `a server mounted under a path keeps it as the prefix`() {
        assertEquals(
            "wss://example.com/push/alerts/ws",
            SubscribeUrl.of("https://example.com/push/", listOf("alerts")),
        )
    }

    @Test
    fun `every topic rides on one connection, comma-separated`() {
        assertEquals(
            "wss://push.example.com/alerts,builds,deploys/ws",
            SubscribeUrl.of("https://push.example.com", listOf("alerts", "builds", "deploys")),
        )
    }

    @Test
    fun `since asks for a replay from that second`() {
        assertEquals(
            "wss://push.example.com/alerts/ws?since=1720000000",
            SubscribeUrl.of("https://push.example.com", listOf("alerts"), since = 1720000000L),
        )
    }

    @Test
    fun `the topic limit is the server's`() {
        val fifty = (1..SubscribeUrl.MAX_TOPICS).map { "topic$it" }
        assertTrue(SubscribeUrl.of("https://push.example.com", fifty).endsWith("/ws"))

        val tooMany = assertThrows(IllegalArgumentException::class.java) {
            SubscribeUrl.of("https://push.example.com", fifty + "topic51")
        }
        assertEquals(SubscribeUrl.TOPIC_COUNT_RULE, tooMany.message)

        val none = assertThrows(IllegalArgumentException::class.java) {
            SubscribeUrl.of("https://push.example.com", emptyList())
        }
        assertEquals(SubscribeUrl.TOPIC_COUNT_RULE, none.message)
    }

    @Test
    fun `a topic outside the server's alphabet is refused, naming the rule`() {
        listOf("bad.topic", "with space", "", "a".repeat(SubscribeUrl.MAX_TOPIC_LENGTH + 1), "a,b").forEach { topic ->
            val refused = assertThrows(IllegalArgumentException::class.java) {
                SubscribeUrl.of("https://push.example.com", listOf(topic))
            }
            assertEquals(SubscribeUrl.TOPIC_RULE, refused.message)
            assertFalse(SubscribeUrl.isValidTopic(topic))
        }

        val longest = "a".repeat(SubscribeUrl.MAX_TOPIC_LENGTH)
        assertTrue(SubscribeUrl.isValidTopic(longest))
        assertEquals(
            "wss://push.example.com/$longest/ws",
            SubscribeUrl.of("https://push.example.com", listOf(longest)),
        )
    }

    @Test
    fun `a topic the server reserves for itself is refused as reserved, not as malformed`() {
        val refused = assertThrows(IllegalArgumentException::class.java) {
            SubscribeUrl.of("https://push.example.com", listOf("healthz"))
        }
        assertEquals("topic \"healthz\" is reserved by the server", refused.message)
        assertFalse(SubscribeUrl.isValidTopic("healthz"))
    }

    @Test
    fun `a server that is not an http or socket URL is refused, naming the rule`() {
        listOf("", "push.example.com", "ftp://push.example.com", "https://", "not a url").forEach { server ->
            val refused = assertThrows(IllegalArgumentException::class.java) {
                SubscribeUrl.of(server, listOf("alerts"))
            }
            assertEquals(SubscribeUrl.SERVER_RULE, refused.message)
        }
    }

    @Test
    fun `a query or fragment on the server URL is refused rather than dropped`() {
        listOf("https://push.example.com?since=1", "https://push.example.com#top").forEach { server ->
            val refused = assertThrows(IllegalArgumentException::class.java) {
                SubscribeUrl.of(server, listOf("alerts"))
            }
            assertEquals(SubscribeUrl.SERVER_RULE, refused.message)
        }
    }

    @Test
    fun `a since before the epoch is refused, naming the rule`() {
        val refused = assertThrows(IllegalArgumentException::class.java) {
            SubscribeUrl.of("https://push.example.com", listOf("alerts"), since = -1L)
        }
        assertEquals(SubscribeUrl.SINCE_RULE, refused.message)

        assertEquals(
            "wss://push.example.com/alerts/ws?since=0",
            SubscribeUrl.of("https://push.example.com", listOf("alerts"), since = 0L),
        )
    }
}
