// Token Launch Radar — entrypoint.
//
// Reads the sealed snapshot from /input/snapshot.json, prices every
// pre-token protocol with the comparables model in lib/model.ts, and writes
// the four deliverables: board.json, a self-contained dashboard, the
// screenshots, and dossier.json (built last, from the files just written).
// Deterministic by construction: no clock, no randomness, fixed locale.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type BoardRow } from './lib/model.ts';

const INPUT_PATH = '/input/snapshot.json';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SCREENSHOT_NAMES = ['1-board.png', '2-detail.png', '3-filtered.png', '4-farm-now.png'];

function main(): void {
  const root = dirname(fileURLToPath(import.meta.url));
  const snapshot = parseSnapshot(readFileSync(INPUT_PATH, 'utf8'));
  const radar = buildRadar(snapshot);

  const board: BoardRow[] = radar.rows.map((row, i) => ({
    slug: row.slug,
    name: row.name,
    rank: i + 1,
    implied_value_usd: row.implied_value_usd,
    farm_steps: row.farm_steps,
  }));
  const issue = boardIssue(board, snapshot.watchlist);
  if (issue !== null) throw new Error(`board gate: ${issue}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);

  const dashboardOut = join(OUTPUT_DIR, 'dashboard');
  cpSync(join(root, 'dashboard'), dashboardOut, { recursive: true });
  writeFileSync(join(dashboardOut, 'zz-data.js'), dataScript(radar));

  const shotsOut = join(OUTPUT_DIR, 'screenshots');
  mkdirSync(shotsOut, { recursive: true });
  const shotsDir = join(root, 'screenshots');
  const present = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => SCREENSHOT_NAMES.includes(f)) : [];
  for (const name of present) cpSync(join(shotsDir, name), join(shotsOut, name));
  if (present.length < 3 || present.length > 4) {
    throw new Error(`expected 3-4 gate-legal screenshots in screenshots/, found ${present.length}`);
  }

  const dossier = buildDossier(OUTPUT_DIR, {
    text_max_bytes: 65_536,
    screenshot_max_count: 4,
    screenshot_max_bytes_each: 524_288,
    dashboard_max_files: 400,
    dashboard_max_bytes: 4_194_304,
  });
  writeFileSync(join(OUTPUT_DIR, 'dossier.json'), `${JSON.stringify(dossier, null, 2)}\n`);
  console.log(`board: ${board.length} rows; dossier sections: ${dossier.sections.length}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
