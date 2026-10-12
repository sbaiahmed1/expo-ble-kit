package expo.modules.blekit.binding

import expo.modules.blekit.core.CoreError
import expo.modules.blekit.core.L2capChannel
import expo.modules.blekit.core.L2capServer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The JS handle of an L2CAP channel (P5-03), with events `data` and `close`. Holds no BLE state:
 * [channel] does, on the BLE thread.
 */
class L2capChannelObject(appContext: AppContext, val channel: L2capChannel) : SharedObject(appContext) {
  init {
    channel.listener = object : L2capChannel.Listener {
      override fun onData(data: ByteArray) {
        emit("data", mapOf("data" to data))
      }

      override fun onClosed(error: CoreError?) {
        emit("close", mapOf("code" to error?.code?.value, "message" to error?.jsMessage))
      }
    }
  }
}

/**
 * The JS handle of an L2CAP server (P5-03). Each accepted channel waits here, announced by a
 * `channel` event, until JS takes it with [take].
 */
class L2capServerObject(appContext: AppContext, val server: L2capServer) : SharedObject(appContext) {
  /** Read by JS's `takeChannel`, written on the BLE thread. */
  private val announced = ConcurrentHashMap<Int, L2capChannelObject>()
  private val nextId = AtomicInteger(1)

  init {
    server.listener = L2capServer.Listener { channel ->
      val id = nextId.getAndIncrement()
      announced[id] = L2capChannelObject(appContext, channel)
      emit("channel", mapOf("channelId" to id))
    }
  }

  /** The channel announced as [id]; null once taken, or when it closed meanwhile. */
  fun take(id: Int): L2capChannelObject? = announced.remove(id)?.takeIf { it.channel.isOpen }

  /** On the BLE thread. */
  fun close() {
    server.close(null)
    announced.clear()
  }
}
