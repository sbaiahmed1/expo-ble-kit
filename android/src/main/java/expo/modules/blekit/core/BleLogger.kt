package expo.modules.blekit.core

import android.util.Log

/** JS `LogLevel` (plan §4.16), most severe first. */
enum class LogLevel(val js: String) {
  NONE("none"),
  ERROR("error"),
  WARN("warn"),
  INFO("info"),
  DEBUG("debug"),
  VERBOSE("verbose"),
  ;

  companion object {
    fun of(js: String) = entries.firstOrNull { it.js == js }
  }
}

/** One log line as JS `LogEntry` gets it; [timestamp] in epoch milliseconds. */
class LogEntry(
  val level: LogLevel,
  val message: String,
  val timestamp: Double,
  val peripheralId: String? = null,
  val opId: Long? = null,
)

/**
 * The core's log (plan §4.16): lines at or above [level] go to Logcat (tag `BleKit`), and to
 * [forward] while JS has a log handler. Messages are built only when their level is on.
 */
class BleLogger(private val clock: () -> Double, private val platform: (LogLevel, String) -> Unit) {
  @Volatile
  var level = LogLevel.WARN

  @Volatile
  var forward: ((LogEntry) -> Unit)? = null

  fun isOn(level: LogLevel) = level != LogLevel.NONE && level.ordinal <= this.level.ordinal

  fun log(level: LogLevel, peripheralId: String? = null, opId: Long? = null, message: () -> String) {
    if (!isOn(level)) return
    val text = message()
    val prefix = listOfNotNull(peripheralId, opId?.let { "op #$it" }).joinToString(" ")
    platform(level, if (prefix.isEmpty()) text else "$prefix: $text")
    forward?.invoke(LogEntry(level, text, clock(), peripheralId, opId))
  }

  companion object {
    const val TAG = "BleKit"

    /** Writes a line to Logcat with the tag `BleKit`. */
    fun logcat(level: LogLevel, line: String) {
      val priority = when (level) {
        LogLevel.ERROR -> Log.ERROR
        LogLevel.WARN -> Log.WARN
        LogLevel.INFO -> Log.INFO
        LogLevel.DEBUG -> Log.DEBUG
        else -> Log.VERBOSE
      }
      Log.println(priority, TAG, line)
    }
  }
}
