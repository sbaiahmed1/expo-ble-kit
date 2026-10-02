// swift-tools-version:5.9
// Builds ios/Core as a standalone Swift package so its unit tests (ios/Tests) run with
// `swift test --package-path ios`, without an app or simulator. The CocoaPods build compiles the
// same files into the ExpoBleKit pod; the podspec excludes this file and ios/Tests.
//
// Plan §4.1: the core must not import ExpoModulesCore or React. This package depends on neither,
// so a violation fails to compile here.
import PackageDescription

let package = Package(
  name: "BleKitCore",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [
    .library(name: "BleKitCore", targets: ["BleKitCore"])
  ],
  targets: [
    .target(name: "BleKitCore", path: "Core"),
    .testTarget(name: "BleKitCoreTests", dependencies: ["BleKitCore"], path: "Tests")
  ],
  swiftLanguageVersions: [.v5]
)
