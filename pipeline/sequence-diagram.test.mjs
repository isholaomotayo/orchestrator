import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSequenceDiagramSvg } from './sequence-diagram.mjs';

const example = `sequenceDiagram
  autonumber
  actor Admin as Administrator (Web UI)
  participant Router as Admin Tax Receipts Page
  participant DB as Database (donations & auditLogs)
  Admin->>Router: Generate Annual Statement
  Router-->>DB: Query donations & <script>alert(1)</script>
  DB-->>Router: Return summary`;

test('sequence diagrams render offline as escaped, accessible SVG', () => {
  const svg = renderSequenceDiagramSvg(example);
  assert.match(svg, /<svg[^>]+role="img"/);
  assert.match(svg, /Administrator \(Web UI\)/);
  assert.match(svg, /Database \(donations &amp; auditLogs\)/);
  assert.match(svg, /1\. Generate Annual Statement/);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});

test('unsupported Mermaid remains source instead of rendering an incomplete diagram', () => {
  assert.equal(renderSequenceDiagramSvg('sequenceDiagram\nalt success\nA->>B: Hello\nend'), null);
});
