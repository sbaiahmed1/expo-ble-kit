package expo.modules.blekit.core

import java.io.IOException

// L2CAP connection-oriented channels (plan §5.5 L2CAP rules, P5-03). Android's sockets block, so
// connect, accept, read and write run on threads of their own ([BlockingRunner]); state and
// callbacks stay on the BLE thread.

/** A `BluetoothSocket` of an LE L2CAP channel. [close] aborts a call blocked on another thread. */
interface L2capSocketPort {
  /** The peer's address. */
  val remoteAddress: String

  /** The most one write sends as one packet (`getMaxTransmitPacketSize`). */
  val maxTransmitPacketSize: Int

  /** The most one read returns (`getMaxReceivePacketSize`). */
  val maxReceivePacketSize: Int

  /** Blocks until the channel is open; throws [IOException] when it fails or [close] aborted it. */
  fun connect()

  /** Blocks until bytes arrive; -1 at the end. Throws [IOException] once closed or broken. */
  fun read(buffer: ByteArray): Int

  /** Blocks until the stack took the bytes. Throws [IOException] once closed or broken. */
  fun write(buffer: ByteArray, offset: Int, length: Int)

  fun close()
}

/** A listening `BluetoothServerSocket` from `listenUsingL2capChannel`. */
interface L2capServerSocketPort {
  /** The PSM the system assigned. */
  val psm: Int

  /** Blocks until a central opens a channel; throws [IOException] once closed. */
  fun accept(): L2capSocketPort

  fun close()
}

/** Starts blocking work on a thread of its own, never on the BLE thread. Tests run it by hand. */
fun interface BlockingRunner {
  fun run(name: String, block: () -> Unit)
}

/** [BlockingRunner] on daemon threads. */
object ThreadRunner : BlockingRunner {
  override fun run(name: String, block: () -> Unit) {
    Thread(block, name).apply { isDaemon = true }.start()
  }
}

/**
 * One open channel. Reading starts with [receive], on a thread of its own: until then nothing is
 * read, and L2CAP's credits hold the peer back. Writes keep their order and go out on a writer
 * thread in pieces of the transmit packet size; a write the stack takes nothing of for
 * [WRITE_STALL_MS] closes the channel.
 *
 * Threading: call everything on the BLE thread ([executor]), where [listener] hears too. [isOpen]
 * is safe from any thread.
 */
class L2capChannel(
  val psm: Int,
  /** The peripheral's address, or the central's on a server's channel. */
  val peerId: String,
  private val socket: L2capSocketPort,
  private val executor: SerialExecutor,
  private val runner: BlockingRunner,
) {
  interface Listener {
    fun onData(data: ByteArray)

    /** Once; [error] is null when either side closed the channel. */
    fun onClosed(error: CoreError?)
  }

  var listener: Listener? = null

  /** Its owner (a session or a server) forgets it. */
  internal var onEnded: ((L2capChannel) -> Unit)? = null

  @Volatile
  var isOpen = true
    private set

  private var receiving = false
  private var closeError: CoreError? = null
  private var stall: Cancellable? = null

  private class PendingWrite(val data: ByteArray, val completion: (Result<Unit>) -> Unit) {
    /** Bytes the stack took. The writer thread's only. */
    var sent = 0

    /** Answered. The BLE thread's only. */
    var settled = false
  }

  /** Guards [pending] and [writerRunning], which the writer thread shares. */
  private val lock = Any()
  private val pending = ArrayDeque<PendingWrite>()
  private var writerRunning = false

  /** Starts reading. Android reports a peer's close and a broken link alike: closed, no error. */
  fun receive() {
    if (receiving || !isOpen) return
    receiving = true
    val buffer = ByteArray(socket.maxReceivePacketSize.takeIf { it > 0 } ?: DEFAULT_PACKET_SIZE)
    runner.run("blekit-l2cap-read") {
      try {
        while (true) {
          val count = socket.read(buffer)
          if (count < 0) break
          val data = buffer.copyOf(count)
          executor.execute { if (isOpen) listener?.onData(data) }
        }
      } catch (_: IOException) {
        // Closed here, by the peer, or with the link.
      }
      executor.execute { close(null) }
    }
  }

  /** Completes once the stack took every byte. */
  fun write(data: ByteArray, completion: (Result<Unit>) -> Unit) {
    if (!isOpen) return completion(Result.failure(writeError()))
    if (data.isEmpty()) return completion(Result.success(Unit))
    val startWriter = synchronized(lock) {
      pending.addLast(PendingWrite(data, completion))
      val idle = !writerRunning
      writerRunning = true
      idle
    }
    if (stall == null) armStall()
    if (startWriter) runner.run("blekit-l2cap-write", ::writeLoop)
  }

  /** Closes the channel: [error] goes to the listener and the pending writes; null when a side closed it. */
  fun close(error: CoreError?) {
    if (!isOpen) return
    isOpen = false
    closeError = error
    stall?.cancel()
    stall = null
    // Aborts the reader and the writer.
    runCatching { socket.close() }
    val failed = synchronized(lock) { pending.toList().also { pending.clear() } }
    failed.forEach { settle(it, Result.failure(writeError())) }
    onEnded?.invoke(this)
    listener?.onClosed(error)
  }

  /** On the writer thread: sends the pending writes in order until none is left. */
  private fun writeLoop() {
    val piece = socket.maxTransmitPacketSize.takeIf { it > 0 } ?: DEFAULT_PACKET_SIZE
    while (true) {
      val write = synchronized(lock) {
        pending.firstOrNull().also { if (it == null) writerRunning = false }
      } ?: return
      try {
        while (write.sent < write.data.size) {
          val length = minOf(piece, write.data.size - write.sent)
          socket.write(write.data, write.sent, length)
          write.sent += length
          executor.execute(::progressed)
        }
      } catch (error: IOException) {
        synchronized(lock) { writerRunning = false }
        executor.execute {
          close(CoreError(CoreError.Code.L2CAP_FAILED, "Writing to L2CAP channel $psm failed: ${error.message}"))
        }
        return
      }
      synchronized(lock) { if (pending.firstOrNull() === write) pending.removeFirst() }
      executor.execute { written(write) }
    }
  }

  private fun written(write: PendingWrite) {
    settle(write, Result.success(Unit))
    if (synchronized(lock) { pending.isEmpty() }) {
      stall?.cancel()
      stall = null
    }
  }

  private fun progressed() {
    if (isOpen) armStall()
  }

  private fun armStall() {
    stall?.cancel()
    stall = executor.executeDelayed(WRITE_STALL_MS) {
      stall = null
      val error = CoreError(
        CoreError.Code.OPERATION_TIMEOUT,
        "L2CAP channel $psm took no bytes for ${WRITE_STALL_MS / 1000} s: the peer stopped reading",
      )
      close(error)
    }
  }

  private fun settle(write: PendingWrite, result: Result<Unit>) {
    if (write.settled) return
    write.settled = true
    write.completion(result)
  }

  private fun writeError() = closeError ?: CoreError(CoreError.Code.L2CAP_FAILED, "L2CAP channel $psm is closed")

  companion object {
    /** A write the stack takes nothing of for this long closes the channel (plan §5.5). */
    const val WRITE_STALL_MS = 10_000L

    /** When the socket doesn't say: the largest LE L2CAP SDU Android uses by default. */
    const val DEFAULT_PACKET_SIZE = 4096
  }
}

/**
 * A published channel server. Accepts on a thread of its own; [close] stops accepting and closes
 * the channels it accepted, which Android's server socket leaves open (`BluetoothServerSocket.close`
 * docs).
 *
 * Threading: like [L2capChannel].
 */
class L2capServer(
  private val socket: L2capServerSocketPort,
  private val executor: SerialExecutor,
  private val runner: BlockingRunner,
) {
  fun interface Listener {
    fun onChannel(channel: L2capChannel)
  }

  val psm: Int = socket.psm
  var listener: Listener? = null

  /** Accepting stopped by itself: a warning for the log. */
  var onWarning: ((CoreError) -> Unit)? = null

  /** Its owner (the engine) forgets it. */
  internal var onEnded: ((L2capServer) -> Unit)? = null

  @Volatile
  var isOpen = true
    private set

  private val channels = linkedSetOf<L2capChannel>()

  fun start() {
    runner.run("blekit-l2cap-accept") {
      try {
        while (true) {
          val accepted = socket.accept()
          executor.execute { accepted(accepted) }
        }
      } catch (error: IOException) {
        executor.execute { stopped(error) }
      }
    }
  }

  /** Stops accepting and closes the channels; [error] goes to their listeners. */
  fun close(error: CoreError?) {
    if (!isOpen) return
    isOpen = false
    runCatching { socket.close() }
    channels.toList().forEach { it.close(error) }
    onEnded?.invoke(this)
  }

  private fun accepted(channelSocket: L2capSocketPort) {
    if (!isOpen) {
      runCatching { channelSocket.close() }
      return
    }
    val peer = normalizeAddress(channelSocket.remoteAddress) ?: channelSocket.remoteAddress
    val channel = L2capChannel(psm, peer, channelSocket, executor, runner)
    channels += channel
    channel.onEnded = { channels -= it }
    val target = listener
    if (target == null) channel.close(null) else target.onChannel(channel)
  }

  private fun stopped(error: IOException) {
    if (!isOpen) return
    onWarning?.invoke(CoreError(CoreError.Code.L2CAP_FAILED, "L2CAP server $psm stopped accepting: ${error.message}"))
    close(null)
  }
}
