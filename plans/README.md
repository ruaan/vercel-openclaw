# Telegram Wake-Speed Plans

This directory holds the staged plan set for reducing the sleeping-sandbox
Telegram wake path.

## Plan order

1. `01-measure-telegram-wake-critical-path.md`
   Establish a real phase-by-phase baseline before changing the restore path.
2. `02-remove-fixed-native-handler-stabilization-delay.md`
   Remove the guaranteed 5-second delay after the native handler first responds.
3. `03-collapse-probe-and-forward-into-one-step.md`
   Remove the synthetic probe round-trip and rely on duplicate-safe forward retries.
4. `04-restore-follow-up-only-if-telegram-bridge-is-not-the-bottleneck.md`
   Only optimize restore internals if measured data shows the Telegram bridge is
   no longer the main bottleneck.

## Working rule

Do the plans in order. Do not start restore-focused optimization until the
measurement plan shows the Telegram bridge is no longer the dominant wake cost,
or until the bridge-focused changes fail to hit the target latency.
