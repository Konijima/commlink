package io.github.konijima.commlink.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The frame the server streams, decoded. The shapes below are the ones `server/src/message.ts`
 * can actually produce, so a change to either side that breaks the other fails here.
 */
class MessageTest {

    @Test
    fun `decodes a message the server published`() {
        val message = Message.fromFrame(
            """
            {"id":"018f-1","topic":"alerts","title":"Disk full","message":"/ is at 98%",
             "priority":5,"tags":["ops","disk"],"timestamp":1752278400}
            """.trimIndent(),
        )

        assertEquals(
            Message(
                id = "018f-1",
                topic = "alerts",
                title = "Disk full",
                message = "/ is at 98%",
                priority = 5,
                tags = listOf("ops", "disk"),
                timestamp = 1752278400,
            ),
            message,
        )
    }

    @Test
    fun `decodes a message published with no title`() {
        val frame = """{"id":"a","topic":"alerts","title":null,"message":"hello","priority":3,"tags":[],"timestamp":1}"""

        val message = Message.fromFrame(frame)

        assertNull(message?.title)
        assertEquals("hello", message?.message)
    }

    @Test
    fun `decodes a message published with only a title`() {
        // The server requires a body or a title, never neither — so a title-only publish
        // arrives with an empty body, not a missing one.
        val frame = """{"id":"a","topic":"alerts","title":"Deployed","message":"","priority":3,"tags":[],"timestamp":1}"""

        val message = Message.fromFrame(frame)

        assertEquals("Deployed", message?.title)
        assertEquals("", message?.message)
    }

    @Test
    fun `ignores a field this app does not know`() {
        // A server newer than the app may add a field. Refusing the whole message over one
        // the app does not read would stop notifications on a server upgrade.
        val frame =
            """{"id":"a","topic":"alerts","title":null,"message":"hi","priority":3,"tags":[],"timestamp":1,"attachment":"x"}"""

        assertEquals("hi", Message.fromFrame(frame)?.message)
    }

    @Test
    fun `refuses a frame that is not JSON`() {
        assertNull(Message.fromFrame("not json at all"))
        assertNull(Message.fromFrame(""))
    }

    @Test
    fun `refuses a frame missing a field the app needs`() {
        assertNull(Message.fromFrame("""{"topic":"alerts","message":"hi","priority":3,"timestamp":1}"""))
    }
}
