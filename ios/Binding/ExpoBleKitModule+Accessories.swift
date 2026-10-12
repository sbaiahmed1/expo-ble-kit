import CoreBluetooth
import ExpoModulesCore
import UIKit

/// JS `AccessoryPickerItem` after the TS layer validated it; `productImage` is a resolved URI.
struct AccessoryPickerItemRecord: Record {
  @Field var name: String = ""
  @Field var productImage: String = ""
  @Field var service: String?
  @Field var companyId: Int?
  @Field var nameSubstring: String?
  @Field var manufacturerData: MaskedDataRecord?
  @Field var serviceData: MaskedDataRecord?
  @Field var immediateRange: Bool = false

  func spec(image: Data) -> AccessoryPickerItemSpec {
    AccessoryPickerItemSpec(
      name: name,
      image: image,
      service: service.map(CBUUID.init(string:)),
      companyId: companyId.flatMap(UInt16.init(exactly:)),
      nameSubstring: nameSubstring,
      manufacturerData: manufacturerData.map { ($0.data, $0.mask) },
      serviceData: serviceData.map { ($0.data, $0.mask) },
      immediateRange: immediateRange
    )
  }
}

struct MaskedDataRecord: Record {
  @Field var data = Data()
  @Field var mask = Data()
}

// iOS 18+ AccessorySetupKit (P5-04): the picker runs on the main queue; it answers with the picked
// accessory's peripheral id, or nil.
extension ExpoBleKitModule {
  func showAccessoryPicker(_ items: [AccessoryPickerItemRecord], _ timeoutMs: Double, _ promise: Promise) {
    guard #available(iOS 18.0, *) else {
      return promise.reject(BleKitException(CoreError(.notSupported, "The accessory picker needs iOS 18")))
    }
    do {
      try AccessoryDeclarations(infoDictionary: Bundle.main.infoDictionary).check(items.map { $0.spec(image: Data()) })
    } catch let error as CoreError {
      return promise.reject(BleKitException(error))
    } catch {
      return promise.reject(error)
    }
    Self.loadImages(items.map(\.productImage)) { result in
      switch result {
      case let .failure(error):
        promise.reject(BleKitException(error))
      case let .success(images):
        let specs = zip(items, images).map { $0.spec(image: $1) }
        DispatchQueue.main.async {
          self.sharedAccessoryPicker().show(specs, timeout: timeoutMs / 1000) { result in
            switch result {
            case let .success(identifier): promise.resolve(identifier?.uuidString)
            case let .failure(error): promise.reject(BleKitException(error))
            }
          }
        }
      }
    }
  }

  /// On the main queue.
  @available(iOS 18.0, *)
  private func sharedAccessoryPicker() -> AccessoryPicker {
    if let accessoryPicker {
      return accessoryPicker
    }
    let picker = AccessoryPicker(queue: .main, scheduler: QueueScheduler(queue: .main)) { ASAccessorySessionAdapter() }
    accessoryPicker = picker
    return picker
  }

  /// Each image's bytes, in order: from Metro in development (http), a file, or the asset catalog.
  private static func loadImages(_ sources: [String], completion: @escaping (Result<[Data], CoreError>) -> Void) {
    var images = [Data?](repeating: nil, count: sources.count)
    var failure: CoreError?
    let group = DispatchGroup()
    let lock = NSLock()
    for (index, source) in sources.enumerated() {
      group.enter()
      loadImage(source) { result in
        lock.lock()
        switch result {
        case let .success(data): images[index] = data
        case let .failure(error): failure = failure ?? error
        }
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: .global()) {
      if let failure { return completion(.failure(failure)) }
      completion(.success(images.compactMap { $0 }))
    }
  }

  private static func loadImage(_ source: String, completion: @escaping (Result<Data, CoreError>) -> Void) {
    let unreadable = CoreError(.invalidArgument, "The product image \(source) can't be loaded")
    if let url = URL(string: source), url.scheme == "http" || url.scheme == "https" {
      let request = URLRequest(url: url, timeoutInterval: 10)
      URLSession.shared.dataTask(with: request) { data, _, _ in
        guard let data, UIImage(data: data) != nil else { return completion(.failure(unreadable)) }
        completion(.success(data))
      }.resume()
      return
    }
    let path = URL(string: source).flatMap { $0.isFileURL ? $0.path : nil } ?? (source.hasPrefix("/") ? source : nil)
    if let path, let data = FileManager.default.contents(atPath: path), UIImage(data: data) != nil {
      return completion(.success(data))
    }
    if let data = UIImage(named: source)?.pngData() {
      return completion(.success(data))
    }
    completion(.failure(unreadable))
  }
}
