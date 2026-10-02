package expo.modules.blekit.core

/** JS `CharacteristicProperty` names for the `PROPERTY_*` bits (plan §5.4), in declaration order. */
fun characteristicProperties(bits: Int): List<String> = listOf(
  CharacteristicProperties.BROADCAST to "broadcast",
  CharacteristicProperties.READ to "read",
  CharacteristicProperties.WRITE_NO_RESPONSE to "writeWithoutResponse",
  CharacteristicProperties.WRITE to "write",
  CharacteristicProperties.NOTIFY to "notify",
  CharacteristicProperties.INDICATE to "indicate",
  CharacteristicProperties.SIGNED_WRITE to "authenticatedSignedWrites",
  CharacteristicProperties.EXTENDED_PROPS to "extendedProperties",
).filter { (bit, _) -> bits and bit != 0 }.map { it.second }

/** JS `Service` with its characteristics and descriptors (plan §5.4). UUIDs are lowercase 128-bit. */
fun GattServiceInfo.toJs(): Map<String, Any?> = mapOf(
  "uuid" to uuid.toString(),
  "isPrimary" to isPrimary,
  "characteristics" to characteristics.map { characteristic ->
    mapOf(
      "uuid" to characteristic.ref.uuid.toString(),
      "serviceUUID" to uuid.toString(),
      "properties" to characteristicProperties(characteristic.properties),
      "descriptors" to characteristic.descriptors.map { descriptor ->
        mapOf("uuid" to descriptor.toString(), "characteristicUUID" to characteristic.ref.uuid.toString())
      },
    )
  },
)
