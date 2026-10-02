## What and why

<!-- The task ID from docs/ARCHITECTURE_AND_PLAN.md §7 (e.g. P1-05), or the issue this fixes, and a short summary. -->

## How it was tested

<!-- Tests added or run (L1 Jest, L2 native, L3 emulator, L4 devices), devices and OS versions used, screenshots for example-app changes. -->

## Checklist (plan §0, Definition of Done)

- [ ] Tests cover the change (L1 and/or L2 at least)
- [ ] Types and docs are updated; a public API change also updates plan §5 and `src/types.ts` (Appendix B, rule 8)
- [ ] The example app still builds on iOS and Android
- [ ] A changeset is added (`yarn changeset`) if users will notice the change
- [ ] Every `⚠️ VERIFY` item this touches is confirmed by an official source, linked above (rule 12)
- [ ] No rule, timeout or test was weakened to make CI pass (rule 15)
- [ ] `docs/ARCHITECTURE_AND_PLAN.md` is updated if the code diverges from it
