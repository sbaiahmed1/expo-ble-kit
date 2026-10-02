package expo.modules.blekit.core

import expo.modules.blekit.core.fakes.service
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.UUID

/** P1-06: the JS shape of discovered services. */
class DiscoveryTest {
  @Test
  fun `property bits map to JS names in declaration order`() {
    assertEquals(emptyList<String>(), characteristicProperties(0))
    assertEquals(
      listOf(
        "broadcast",
        "read",
        "writeWithoutResponse",
        "write",
        "notify",
        "indicate",
        "authenticatedSignedWrites",
        "extendedProperties",
      ),
      characteristicProperties(0xFF),
    )
    assertEquals(
      listOf("read", "notify"),
      characteristicProperties(CharacteristicProperties.READ or CharacteristicProperties.NOTIFY),
    )
  }

  @Test
  fun `services have the JS Service shape`() {
    val base = service("180f", "2a19" to CharacteristicProperties.READ)
    val withDescriptor = base.copy(
      characteristics = listOf(
        base.characteristics[0].copy(descriptors = listOf(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))),
      ),
    )
    assertEquals(
      mapOf(
        "uuid" to "0000180f-0000-1000-8000-00805f9b34fb",
        "isPrimary" to true,
        "characteristics" to listOf(
          mapOf(
            "uuid" to "00002a19-0000-1000-8000-00805f9b34fb",
            "serviceUUID" to "0000180f-0000-1000-8000-00805f9b34fb",
            "properties" to listOf("read"),
            "descriptors" to listOf(
              mapOf(
                "uuid" to "00002902-0000-1000-8000-00805f9b34fb",
                "characteristicUUID" to "00002a19-0000-1000-8000-00805f9b34fb",
              ),
            ),
          ),
        ),
      ),
      withDescriptor.toJs(),
    )
  }
}
