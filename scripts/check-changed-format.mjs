import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Cannot establish the formatting comparison');
  return result.stdout.trim();
}

// Enforce formatting for this change without rewriting historical source files.
let base = process.env.FORMAT_BASE_SHA;
if (!base || /^0+$/.test(base)) base = git(['rev-parse', 'HEAD^']);
if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error('Invalid formatting base commit');
const names = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base, 'HEAD'])
  .split('\0')
  .filter((name) => /\.(?:[cm]?[jt]s|json|md|ya?ml)$/.test(name));
if (names.length) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', '--', ...names],
    { stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
} else {
  console.log('No changed files require Prettier checks.');
}
