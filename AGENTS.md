# expo-ble-kit

Before any change, read docs/ARCHITECTURE_AND_PLAN.md (§0, §3, Appendix B).
Only work on tasks from §7 whose dependencies are done. Stop at any [GATE].
Never weaken a rule from Appendix B to make a test pass.

## Commands

Yarn is pinned in this repo (`.yarnrc.yml`, `.yarn/releases`). Run everything from the repo root unless noted.

```bash
yarn install                 # root (library) dependencies
yarn prepare                 # build src/ and plugin/ once (CI mode, no watch)
yarn typecheck               # tsc for src/ and plugin/
yarn lint                    # ESLint (universe config)
yarn lint:native             # SwiftLint + ktlint (brew install swiftlint ktlint)
CI=1 yarn test               # Jest, no watch mode
CI=1 yarn test plugin        # config plugin tests (snapshots, plugin order, bare guide)
swift test --package-path ios   # iOS core unit tests (no simulator needed)
(cd example/android && ./gradlew :expo-ble-kit:testDebugUnitTest)   # Android core unit tests
yarn check:package           # fail if npm would ship tests, build output, docs or tooling
yarn docs                    # API reference into docs/api; fails on any undocumented public symbol
yarn changeset               # add a changeset for any user-facing change

cd example && yarn install   # example app dependencies (separate lockfile)
cd example && yarn test      # example screens against the fake adapter (Jest, library from ../src)
cd example && npx expo prebuild --clean   # regenerate example/ios and example/android (gitignored)
cd example && npx expo run:ios            # or run:android

cd website && yarn install    # documentation website dependencies (separate lockfile)
cd website && yarn start      # the website with live reload (search works only in a build)
cd website && yarn build      # the website into website/build; fails on broken links and anchors

cd test-peripherals/bumble && uv run pytest              # test peripheral tests (no hardware)
cd test-peripherals/bumble && uv run blekit-peripheral   # advertise on a running Android emulator
e2e/android-netsim/run.sh    # L3: peripheral + instrumented tests on a running emulator (needs ANDROID_HOME and example/android)
e2e/macos-central/run.sh     # this Mac as the central for the example's GATT server on a phone (P4-01, P4-02, P5-03)
e2e/macos-peripheral/run.sh  # this Mac as an L2CAP echo peripheral for the example's L2CAP check (P5-03)
maestro test e2e/maestro/explorer-basic.yaml            # example flows; add -e DEMO=true to use the app's virtual test peripheral
```

`test-peripherals/profile.json` is the single source of truth for the test GATT profile; change it before any implementation.

`test-contracts/` holds behavior cases shared by the native cores and the TypeScript fake: the GATT queue and the GATT server's long reads. Swift, Kotlin and Jest tests all run them; a change of that behavior starts there.

## Conventions

- Commit messages: plain subject and body. No `Co-Authored-By` or session trailers.
- Native code layout and layer rules: §4.1–§4.2 of the plan. Core code never imports Expo or React.
- `example/ios` and `example/android` are generated (CNG). Configure native behavior through the config plugin in `plugin/`, never by editing generated projects.
