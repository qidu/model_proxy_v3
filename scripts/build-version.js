import { execFileSync } from 'child_process';

export function formatBuildVersion(gitDescription) {
  return gitDescription.replace(
    /-(\d+)-g([0-9a-f]+)(-dirty)?$/,
    (_, distance, commit, dirty = '') => {
      const number = Number(distance);
      const suffix = number % 100 >= 11 && number % 100 <= 13
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
      return `-${distance}${suffix}-g${commit}${dirty}`;
    },
  );
}

export function getBuildVersion(root) {
  if (process.env.VERSION) return process.env.VERSION;
  const gitDescription = execFileSync(
    'git',
    ['describe', '--tags', '--long', '--always', '--dirty'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  return formatBuildVersion(gitDescription);
}
