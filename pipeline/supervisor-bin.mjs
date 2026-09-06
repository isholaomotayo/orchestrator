#!/usr/bin/env node
// Entry point for the supervisor daemon. Kept separate from supervisor.mjs so
// the module can be imported and driven tick-by-tick in tests without ever
// taking a lock or starting a timer.
import { createSupervisor } from './supervisor.mjs';

const supervisor = createSupervisor({ repoRoot: process.cwd() });
try {
  supervisor.start();
} catch (err) {
  console.error(`[supervisor] ${err.message}`);
  process.exit(1);
}
