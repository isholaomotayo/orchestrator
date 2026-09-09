#!/usr/bin/env node
// Portable host/chat progress bridge. An IDE session completing a stage
// publishes concise progress here so the dashboard has a transcript without
// scraping the chat. Validates run, stage, and kind before writing.
import { runHostEventCli } from './events.mjs';

try {
  const result = runHostEventCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
