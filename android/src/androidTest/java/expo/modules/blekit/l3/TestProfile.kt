package expo.modules.blekit.l3

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * Reads test-peripherals/profile.json, the single source of truth for the test GATT profile.
 * The build copies it into this test APK's assets (see android/build.gradle).
 */
class TestProfile(private val json: JSONObject) {
  private val characteristics: Map<String, JSONObject> = buildMap {
    val services = json.getJSONArray("services")
    for (i in 0 until services.length()) {
      val service = services.getJSONObject(i)
      put(service.getString("key"), service)
      val chars = service.getJSONArray("characteristics")
      for (j in 0 until chars.length()) {
        val characteristic = chars.getJSONObject(j)
        put(characteristic.getString("key"), characteristic)
      }
    }
  }

  /** UUID of a service or characteristic, by key. */
  fun uuid(key: String): UUID = UUID.fromString(entry(key).getString("uuid"))

  /** Decoded `value` of a characteristic: {"pattern": {...}}, {"hex": "..."} or {"utf8": "..."}. */
  fun value(key: String): ByteArray = decode(entry(key).getJSONObject("value"))

  val localName: String
    get() = json.getJSONObject("advertising").getJSONObject("scanResponseData").getString("completeLocalName")

  val manufacturerCompanyId: Int
    get() = manufacturerData().getInt("companyId")

  val manufacturerPayload: ByteArray
    get() = hex(manufacturerData().getString("data"))

  private fun manufacturerData(): JSONObject =
    json.getJSONObject("advertising").getJSONObject("scanResponseData").getJSONObject("manufacturerData")

  private fun entry(key: String): JSONObject = characteristics[key] ?: error("Unknown profile key $key")

  companion object {
    fun load(context: Context): TestProfile =
      context.assets.open("profile.json").bufferedReader().use { TestProfile(JSONObject(it.readText())) }

    private fun decode(spec: JSONObject): ByteArray = when {
      spec.has("pattern") -> {
        val pattern = spec.getJSONObject("pattern")
        val multiplier = pattern.getInt("multiplier")
        val offset = pattern.getInt("offset")
        val modulus = pattern.getInt("modulus")
        ByteArray(pattern.getInt("length")) { i -> ((i * multiplier + offset) % modulus).toByte() }
      }

      spec.has("hex") -> hex(spec.getString("hex"))

      spec.has("utf8") -> spec.getString("utf8").toByteArray(Charsets.UTF_8)

      else -> error("Unknown value spec $spec")
    }

    private fun hex(value: String): ByteArray = ByteArray(value.length / 2) { i ->
      value.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    }
  }
}
