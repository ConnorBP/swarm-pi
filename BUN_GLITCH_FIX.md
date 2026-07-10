# Bun standalone path glitch fix

## Problem

`piInvocation()` recognized Bun standalone virtual script paths only in the Unix form:

```text
/$bunfs/root/...
```

On Windows, Bun exposes standalone-binary paths in this form instead:

```text
B:\~BUN\root\...
```

Because the Windows path was not classified as virtual, the runner attempted `fs.existsSync()` against it. This could lead workers to receive or focus on the nonexistent virtual path (for example, `B:/~BUN/root/pi.exe`) rather than reinvoking the current standalone executable correctly.

## Fix

Updated `runner.ts` so `piInvocation()` recognizes both forms:

```typescript
const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") || currentScript?.includes("~BUN");
```

Bun virtual paths now bypass the physical-file existence branch on Unix and Windows. The standalone executable falls through to the existing `process.execPath` invocation path.

## Verification

Reviewed the complete `runner.ts`. There are no other `/$bunfs`, `~BUN`, or Bun virtual-path assumptions requiring changes.
