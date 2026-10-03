# Native reference apps

Two small apps that run the transfers of [docs/benchmarks.md](../docs/benchmarks.md) with the platform Bluetooth API and nothing else, so expo-ble-kit's throughput can be compared with native code on the same phone and peripheral (plan P2-08).

| App | Built with | Build |
|---|---|---|
| `android-reference` | Kotlin, `android.bluetooth`, no AndroidX | `./gradlew :app:installRelease` (needs `ANDROID_HOME`) |
| `ios-reference` | SwiftUI, CoreBluetooth | Open `BleKitReference.xcodeproj`, pick a team, run Release on an iPhone |

Both find the test peripheral by its service, connect, and print one line per transfer in the format of the example app's Throughput tab. They are not part of the npm package.
