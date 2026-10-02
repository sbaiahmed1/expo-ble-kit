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
yarn changeset               # add a changeset for any user-facing change

cd example && yarn install   # example app dependencies (separate lockfile)
cd example && npx expo prebuild --clean   # regenerate example/ios and example/android (gitignored)
cd example && npx expo run:ios            # or run:android

cd test-peripherals/bumble && uv run pytest              # test peripheral tests (no hardware)
cd test-peripherals/bumble && uv run blekit-peripheral   # advertise on a running Android emulator
```

`test-peripherals/profile.json` is the single source of truth for the test GATT profile; change it before any implementation.

## Conventions

- Commit messages: plain subject and body. No `Co-Authored-By` or session trailers.
- Native code layout and layer rules: §4.1–§4.2 of the plan. Core code never imports Expo or React.
- `example/ios` and `example/android` are generated (CNG). Configure native behavior through the config plugin in `plugin/`, never by editing generated projects.
