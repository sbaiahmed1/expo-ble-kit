package expo.modules.blekit.core

/**
 * The latest name seen for each peripheral (plan §4.7), for the synchronous `Peripheral.name`:
 * written on the BLE thread, read from any thread. Keeps the [capacity] most recently used names.
 */
class PeripheralNames(private val capacity: Int = 1_000) {
  private val names = object : LinkedHashMap<String, String>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>) = size > capacity
  }

  @Synchronized
  operator fun get(id: String): String? = names[id]

  /** A null [name] keeps the one already known. */
  @Synchronized
  operator fun set(id: String, name: String?) {
    if (!name.isNullOrEmpty()) names[id] = name
  }
}
