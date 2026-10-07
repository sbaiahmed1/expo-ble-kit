require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
# npm normalizes `repository` to { "type": "git", "url": "git+https://…" }; CocoaPods needs the URL.
repository = package['repository']
repository = repository['url'] if repository.is_a?(Hash)
repository = repository.sub(/\Agit\+/, '')

Pod::Spec.new do |s|
  s.name           = 'ExpoBleKit'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only: other Apple platforms are a non-goal for 1.0 (docs/ARCHITECTURE_AND_PLAN.md §1.3).
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: repository, tag: "v#{s.version}" }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  # Core unit tests run through the Swift package in Package.swift (§4.2) and never ship in the pod.
  s.exclude_files = ["Tests/**/*", "Package.swift", ".build/**/*"]
end
