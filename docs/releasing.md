# Releasing

From 2.0, releases go to npm's `latest` tag. Before it, 0.x versions went to `next` (plan §9): npm 11 ignores a tag in `publishConfig`, so the `prepublishOnly` script (`internal/check-publish-tag.js`) refuses to publish a 0.x version without `--tag next`. A prerelease of a stable version (`2.1.0-rc.0`) goes to `next` too: `npm publish --tag next`.

## Checklist

1. **Hardware.** The example app (a debug build is fine) on an Android phone and an iPhone, next to each other:
   - `e2e/maestro/two-phone.sh <phone B> <phone A>`, then with the phones swapped: the two-phone suite in both directions (P4-05).
   - On the phone acting as the central, against the other one's Peripheral tab: Explorer, Heart Rate, and the developer checks of the test peripheral (1 MB sink, `writeStream`, the batched stream).
   - `e2e/macos-central/run.sh` with the iPhone advertising (**Checks → GATT server**): the advertised fields (P4-03).
   - Record the results in the plan's progress notes and in the README's "Tested on hardware".
2. **Version.** `yarn changeset version` bumps `package.json`, writes `CHANGELOG.md` and removes the changesets. Update the README's compatibility table and `docs/compatibility.md`. Commit as `Release x.y.z`.
3. **Checks.** `yarn lint`, `yarn lint:native`, `yarn typecheck`, `CI=1 yarn test`, `cd example && yarn test`, `swift test --package-path ios`, the Android unit tests, `yarn docs` and `yarn check:package`. The example builds on both platforms, after the last change to `package.json`: the podspec reads its `version`, `description` and `repository` (0.1.0 broke `pod install` because `npm pkg fix` made `repository` an object).
4. **Publish.** `npm login` with the owner's account, then `npm publish` (it runs `prepare`, which builds `build/` and `plugin/build/`; `npm publish --dry-run` first shows the contents). Check with `npm view expo-ble-kit dist-tags`.
5. **Tag.** `git tag vx.y.z` and push the branch and the tag; a GitHub release with the changelog section is optional.
