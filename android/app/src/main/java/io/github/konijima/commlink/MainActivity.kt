package io.github.konijima.commlink

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.konijima.commlink.net.Subscription
import io.github.konijima.commlink.service.SubscriberService
import io.github.konijima.commlink.service.SubscriptionStore
import io.github.konijima.commlink.ui.theme.CommlinkTheme

class MainActivity : ComponentActivity() {

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        askToNotify()

        val store = SubscriptionStore(this)
        configureFromIntent()?.let { SubscriberService.start(this, it) }

        setContent {
            CommlinkTheme {
                Scaffold { padding ->
                    HomeScreen(store.load(), Modifier.padding(padding))
                }
            }
        }
    }

    /**
     * A message the app cannot show is a message that did not arrive, as far as anyone using
     * it is concerned, so the permission is asked for at launch rather than at the first
     * message — by which time the notification would already have been dropped. Answering no
     * is respected: nothing here depends on the answer, and the connection runs regardless.
     */
    private fun askToNotify() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /**
     * The subscription named on the launch intent, in a debug build.
     *
     * There is no settings screen yet, so this is how a debug build is pointed at a server
     * before one exists — see `android/README.md`. It is off in a release build: a launch
     * intent is something any app on the device can send, and this one carries the token the
     * app authenticates with.
     */
    private fun configureFromIntent(): Subscription? {
        if (!BuildConfig.DEBUG) return null

        val server = intent?.getStringExtra(EXTRA_SERVER) ?: return null
        val token = intent?.getStringExtra(EXTRA_TOKEN) ?: return null
        val topics = intent?.getStringExtra(EXTRA_TOPIC)
            ?.split(",")
            ?.map(String::trim)
            ?.filter(String::isNotEmpty)
            .orEmpty()
        if (topics.isEmpty()) return null

        return Subscription(server = server, token = token, topics = topics)
    }

    private companion object {
        const val EXTRA_SERVER = "server"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_TOPIC = "topic"
    }
}

@Composable
fun HomeScreen(subscription: Subscription?, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = "commlink", style = MaterialTheme.typography.headlineMedium)
        Text(
            text = if (subscription == null) {
                "Not subscribed to anything yet."
            } else {
                "Subscribed to ${subscription.topics.joinToString(", ")} on ${subscription.server}"
            },
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Preview
@Composable
private fun HomeScreenPreview() {
    CommlinkTheme {
        HomeScreen(Subscription("https://push.example.com", "a-token", listOf("alerts", "builds")))
    }
}
