// Launch Radar — Research Desk v9 (token-radar-01).
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>),
// prices every pre-token protocol with the model in lib/model.ts, writes the
// ranked board to /output/board.json, copies dashboard/ and screenshots/
// across, generates the dashboard's dataset as dashboard/zz-data.js, and
// writes /output/dossier.json last, with the vendored buildDossier. Node 22,
// standard library only.
//
// Determinism is a gate, not a hope: no clock, no randomness, no locale
// formatting anywhere in the pipeline, and the board's sort is a total
// order — two runs over the same snapshot write identical bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, mirrored so an over-limit output fails here first. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(
    `launch radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

/** Copy one directory's regular files into `to`, skipping dotfiles, and
 *  return the names copied. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dataset is generated, never committed: it lands beside the page in
// the output only, under the name that sorts last in the dossier.
writeFileSync(join(out, 'dashboard', 'zz-data.js'), dataScript(radar));

const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > SCREENSHOT_CAPS.max) {
  process.stderr.write(
    `launch radar: screenshots/ holds ${shots.length} images: hand in 3 or 4 (board, detail, filtered, farm-now)\n`,
  );
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch radar: screenshots/${name}: not a gate-legal image name\n`);
    process.exit(1);
  }
}

// The dossier goes last: the scorer rebuilds it from this same output and
// compares bytes, so everything it describes must already be on disk.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: DASHBOARD_CAPS,
  }),
);

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
    `${board.length} pre-token rows ranked (${radar.meta.watchlist_covered}/${radar.meta.watchlist_count} watchlist covered)\n` +
    `launch radar: wrote board.json, dashboard/ (${dashboardFiles.length + 1} files incl. zz-data.js), ` +
    `screenshots/ (${shots.length} images) and dossier.json under ${out}\n`,
);
