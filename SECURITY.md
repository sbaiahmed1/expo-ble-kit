# Security policy

## Supported versions

expo-ble-kit is pre-1.0. Only the latest published version (on the `next` dist-tag until 1.0) receives security fixes. After 1.0, fixes go to the latest minor release.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/sbaiahmed1/expo-ble-kit/security/advisories/new)).

Include:

- the affected version, platform (iOS / Android) and OS version;
- what an attacker can do, and under which conditions (for example: within radio range, with a malicious peripheral, with access to logs);
- steps or code to reproduce, and the peripheral involved if relevant.

You should get an acknowledgement within 7 days. Once a fix is released, the advisory is published with credit to the reporter, unless you prefer otherwise.

## Scope

In scope: the library's TypeScript API, native code (iOS and Android) and config plugin. Examples:

- crashes or memory corruption triggered by malformed advertisements or GATT data from a nearby or connected peripheral;
- pairing or bonding handled less safely than documented (the library never auto-confirms pairing);
- Bluetooth data, identifiers or keys leaking through logs, diagnostics or background event buffers beyond what is documented;
- the config plugin adding permissions, background modes or exported components that aren't documented.

Out of scope: vulnerabilities in the operating system's Bluetooth stack or in peripheral firmware, and the example app and test peripherals (`example/`, `test-peripherals/`, `e2e/`) unless they affect apps that use the library. Report those upstream.

## Sharing diagnostics safely

`BleManager.getDiagnostics()` output and debug logs can contain device names and identifiers. Redact anything you don't want public before attaching them to issues.
