#!/usr/bin/env node

import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBuildVersion } from './build-version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildVersion = getBuildVersion(ROOT);
writeFileSync(
  path.join(ROOT, 'dist', 'version.js'),
  `export const BUILD_VERSION = ${JSON.stringify(buildVersion)};\n`,
);
console.error(`[build] build version: ${buildVersion}`);
