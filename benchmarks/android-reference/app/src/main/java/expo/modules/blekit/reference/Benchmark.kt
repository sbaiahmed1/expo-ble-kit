package expo.modules.blekit.reference

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** The test peripheral (test-peripherals/profile.json). */
private object Profile {
  val TEST: UUID = UUID.fromString("0c6c1000-b347-4cfa-9827-1c5a13658519")
  val ECHO_WRITE: UUID = UUID.fromString("0c6c1003-b347-4cfa-9827-1c5a13658519")
  val SINK_NO_RSP: UUID = UUID.fromString("0c6c1005-b347-4cfa-9827-1c5a13658519")
  val SINK_COUNTER: UUID = UUID.fromString("0c6c1006-b347-4cfa-9827-1c5a13658519")
  val STREAM: UUID = UUID.fromString("0c6c1007-b347-4cfa-9827-1c5a13658519")
  val CONTROL: UUID = UUID.fromString("0c6c100b-b347-4cfa-9827-1c5a13658519")
  val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  val RESET_COUNTERS = byteArrayOf(0x04)

  fun setStream(rateHz: Int, frameSize: Int) = byteArrayOf(
    0x01,
    rateHz.toByte(),
    (rateHz shr 8).toByte(),
    frameSize.toByte(),
    (frameSize shr 8).toByte(),
  )
}

/** One measured transfer, in the same shape as the example's Throughput screen (docs/benchmarks.md). */
data class Result(val name: String, val bytes: Long, val millis: Double, val note: String) {
  val kilobytesPerSecond get() = bytes / 1024.0 / (millis / 1000.0)

  override fun toString() =
    "%s: %d B in %.2f s = %.1f KB/s (%s)".format(name, bytes, millis / 1000, kilobytesPerSecond, note)
}

/**
 * The three transfers of docs/benchmarks.md with android.bluetooth and nothing else: writes without
 * response (1 MiB to SINK_NO_RSP), writes with response (256 KiB to ECHO_WRITE), and notifications
 * (STREAM at 1000 Hz for 10 s). Blocking calls on a worker thread; GATT callbacks feed [events].
 */
@SuppressLint("MissingPermission")
class Benchmark(private val context: Context, private val log: (String) -> Unit) {
  private sealed interface Event {
    data class Connection(val status: Int, val state: Int) : Event

    data class Mtu(val mtu: Int) : Event

    data class Discovered(val status: Int) : Event

    data class Wrote(val status: Int) : Event

    data class DescriptorWrote(val status: Int) : Event

    data class Read(val value: ByteArray) : Event
  }

  private val events = LinkedBlockingQueue<Event>()
  private val notified = AtomicLong()
  private val frames = AtomicLong()
  private val gaps = AtomicLong()
  private var expected = 0L
  private lateinit var gatt: BluetoothGatt
  private var mtu = 23

  fun runAll(): List<Result> {
    val device = scan()
    connect(device)
    try {
      return listOf(
        writeWithoutResponse(1 shl 20),
        writeWithResponse(256 shl 10),
        notifications(seconds = 10),
      ).onEach { log("RESULT $it") }
    } finally {
      gatt.disconnect()
      gatt.close()
    }
  }

  private fun scan(): BluetoothDevice {
    val scanner = context.getSystemService(BluetoothManager::class.java).adapter.bluetoothLeScanner
    val found = LinkedBlockingQueue<BluetoothDevice>()
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        found.offer(result.device)
      }
    }
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(Profile.TEST)).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    scanner.startScan(listOf(filter), settings, callback)
    val device = found.poll(10, TimeUnit.SECONDS)
    scanner.stopScan(callback)
    return device ?: error("No test peripheral found in 10 s")
  }

  private fun connect(device: BluetoothDevice) {
    log("Connecting to ${device.address}")
    gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    val connected = await<Event.Connection>(15)
    check(connected.state == BluetoothProfile.STATE_CONNECTED) { "Connect failed: status ${connected.status}" }
    gatt.requestMtu(517)
    mtu = await<Event.Mtu>(10).mtu
    gatt.discoverServices()
    check(await<Event.Discovered>(30).status == BluetoothGatt.GATT_SUCCESS) { "Discovery failed" }
    log("Connected, MTU $mtu")
  }

  private fun characteristic(uuid: UUID): BluetoothGattCharacteristic =
    gatt.getService(Profile.TEST).getCharacteristic(uuid)

  /** Submits a write, retrying while the stack is busy (one outstanding write per device). */
  @Suppress("DEPRECATION")
  private fun submit(uuid: UUID, value: ByteArray, writeType: Int) {
    val target = characteristic(uuid)
    while (true) {
      val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val status = gatt.writeCharacteristic(target, value, writeType)
        check(status == BluetoothStatusCodes.SUCCESS || status == BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
          "Write refused: $status"
        }
        status == BluetoothStatusCodes.SUCCESS
      } else {
        target.writeType = writeType
        target.value = value
        gatt.writeCharacteristic(target)
      }
      if (ok) return
      Thread.sleep(5)
    }
  }

  /** Writes and waits for the callback; GATT_CONNECTION_CONGESTED means the stack took the packet. */
  private fun write(uuid: UUID, value: ByteArray, writeType: Int) {
    while (true) {
      submit(uuid, value, writeType)
      when (val status = await<Event.Wrote>(10).status) {
        BluetoothGatt.GATT_SUCCESS, BluetoothGatt.GATT_CONNECTION_CONGESTED -> return

        INTERNAL_ERROR -> Thread.sleep(10)

        // refused while congested: nothing was sent
        else -> error("Write failed with status $status")
      }
    }
  }

  private fun control(command: ByteArray) =
    write(Profile.CONTROL, command, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)

  @Suppress("DEPRECATION")
  private fun readCounter(): Long {
    gatt.readCharacteristic(characteristic(Profile.SINK_COUNTER))
    val value = await<Event.Read>(10).value
    return (0 until 4).fold(0L) { total, i -> total or ((value[i].toLong() and 0xFF) shl (8 * i)) }
  }

  private fun payload(offset: Int, size: Int) = ByteArray(size) { ((offset + it) % 256).toByte() }

  private fun writeWithoutResponse(total: Int): Result {
    control(Profile.RESET_COUNTERS)
    val packet = mtu - 3
    val started = SystemClock.elapsedRealtimeNanos()
    var sent = 0
    while (sent < total) {
      val size = minOf(packet, total - sent)
      write(Profile.SINK_NO_RSP, payload(sent, size), BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
      sent += size
    }
    val millis = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
    var counted = readCounter()
    repeat(10) {
      if (counted >= total) return@repeat
      Thread.sleep(200)
      counted = readCounter()
    }
    return Result("writeWithoutResponse", total.toLong(), millis, "$packet-byte packets, peripheral counted $counted")
  }

  private fun writeWithResponse(total: Int): Result {
    val packet = mtu - 3
    val started = SystemClock.elapsedRealtimeNanos()
    var sent = 0
    while (sent < total) {
      val size = minOf(packet, total - sent)
      write(Profile.ECHO_WRITE, payload(sent, size), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
      sent += size
    }
    val millis = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
    return Result("writeWithResponse", total.toLong(), millis, "$packet-byte packets")
  }

  @Suppress("DEPRECATION")
  private fun notifications(seconds: Int): Result {
    val stream = characteristic(Profile.STREAM)
    gatt.setCharacteristicNotification(stream, true)
    val cccd = stream.getDescriptor(Profile.CCCD)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
    } else {
      cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      gatt.writeDescriptor(cccd)
    }
    await<Event.DescriptorWrote>(10)
    control(Profile.RESET_COUNTERS)
    val frameSize = minOf(mtu - 3, 512)
    expected = 0
    notified.set(0)
    frames.set(0)
    gaps.set(0)
    val started = SystemClock.elapsedRealtimeNanos()
    control(Profile.setStream(1000, frameSize))
    Thread.sleep(seconds * 1000L)
    val bytes = notified.get()
    val millis = (SystemClock.elapsedRealtimeNanos() - started) / 1e6
    control(Profile.setStream(0, frameSize))
    return Result("notifications", bytes, millis, "${frames.get()} frames of $frameSize B, ${gaps.get()} gaps")
  }

  private inline fun <reified T : Event> await(seconds: Long): T {
    val deadline = SystemClock.elapsedRealtime() + seconds * 1000
    while (true) {
      val left = deadline - SystemClock.elapsedRealtime()
      val event = events.poll(left.coerceAtLeast(0), TimeUnit.MILLISECONDS)
        ?: error("Timed out waiting for ${T::class.simpleName}")
      if (event is T) return event
      if (event is Event.Connection && event.state == BluetoothProfile.STATE_DISCONNECTED) {
        error("Disconnected (status ${event.status})")
      }
    }
  }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      events.offer(Event.Connection(status, newState))
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      events.offer(Event.Mtu(mtu))
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      events.offer(Event.Discovered(status))
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      events.offer(Event.Wrote(status))
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      events.offer(Event.DescriptorWrote(status))
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) {
      events.offer(Event.Read(value))
    }

    @Deprecated("Before API 33")
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT <
        Build.VERSION_CODES.TIRAMISU
      ) {
        events.offer(Event.Read(characteristic.value ?: ByteArray(0)))
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      countFrame(value)
    }

    @Deprecated("Before API 33")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) countFrame(characteristic.value ?: ByteArray(0))
    }
  }

  /** Frames start with their uint32 LE sequence number (profile.json stream.frame). */
  private fun countFrame(value: ByteArray) {
    if (value.size < 4) return
    val sequence = (0 until 4).fold(0L) { total, i -> total or ((value[i].toLong() and 0xFF) shl (8 * i)) }
    if (sequence > expected) gaps.addAndGet(sequence - expected)
    expected = sequence + 1
    frames.incrementAndGet()
    notified.addAndGet(value.size.toLong())
  }

  private companion object {
    /** The stack's GATT_INTERNAL_ERROR: L2CAP refused the packet while congested. */
    const val INTERNAL_ERROR = 0x81
  }
}
