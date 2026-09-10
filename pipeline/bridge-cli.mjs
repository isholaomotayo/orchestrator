#!/usr/bin/env node
import fs from 'node:fs';
import { bridgeCommand, completeStage, inspectBridge } from './bridge.mjs';

export async function executeBridge(command, args) {
  if (command === 'stage.complete') return completeStage(args);
  if (command === 'run.wait') {
    const end = Date.now() + Math.min(Math.max(Number(args.timeoutMs) || 30000, 0), 60000);
    do {
      const value = inspectBridge(args.project, args.runId);
      if (value.revision > (args.afterRevision ?? -1) || Date.now() >= end) return value;
      await new Promise(r => setTimeout(r, 250));
    } while (true);
  }
  return bridgeCommand(command, args);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const [command, ...flags] = process.argv.slice(2);
    const index = flags.indexOf('--input-file');
    const input = index >= 0 ? fs.readFileSync(flags[index + 1], 'utf8') : fs.readFileSync(0, 'utf8');
    const value = await executeBridge(command, JSON.parse(input));
    process.stdout.write(JSON.stringify(value) + '\n');
    if (value.ok === false) process.exitCode = 1;
  } catch (err) { process.stderr.write(err.message + '\n'); process.exitCode = 1; }
}
