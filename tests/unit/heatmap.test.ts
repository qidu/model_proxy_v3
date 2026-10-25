import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHeatmap,
  buildMonthlyHeatmap,
  getAnsiColor,
  renderHeatmapPanel,
  renderMonthlyHeatmapPanel,
} from '../../src/heatmap.js';

const EMPTY_COLOR = '\x1b[38;2;22;27;34m';
const VALUE_COLORS = [
  '\x1b[38;2;8;48;107m',
  '\x1b[38;2;13;71;161m',
  '\x1b[38;2;21;101;192m',
  '\x1b[38;2;25;118;210m',
  '\x1b[38;2;30;136;229m',
  '\x1b[38;2;66;165;245m',
  '\x1b[38;2;144;202;249m',
  '\x1b[38;2;187;222;251m',
  '\x1b[38;2;227;242;253m',
  '\x1b[38;2;255;255;255m',
] as const;

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const boldWhite = (text: string) => `\x1b[1;97m${text}\x1b[0m`;

function weeklyFixture() {
  return buildHeatmap([
    { weekday: 0, hour: 0, values: 2 },
    { weekday: 0, hour: 0, values: 3 },
    { weekday: 3, hour: 12, values: 1 },
    { weekday: 6, hour: 23, values: 7 },
  ]);
}

function monthlyFixture() {
  return buildMonthlyHeatmap([
    { day: 1, values: 2 },
    { day: 1, values: 3 },
    { day: 15, values: 1 },
    { day: 31, values: 7 },
  ]);
}

describe('getAnsiColor', () => {
  it('returns the empty color for zero and negative values', () => {
    assert.equal(getAnsiColor(0, 10), EMPTY_COLOR);
    assert.equal(getAnsiColor(-1, 10), EMPTY_COLOR);
  });

  it('returns the empty color when the maximum is zero or negative', () => {
    assert.equal(getAnsiColor(1, 0), EMPTY_COLOR);
    assert.equal(getAnsiColor(1, -10), EMPTY_COLOR);
  });

  it('selects every exact tier and clamps values at or above the maximum', () => {
    for (let tier = 0; tier < VALUE_COLORS.length; tier += 1) {
      const value = tier === 0 ? 1 : tier * 10;
      assert.equal(getAnsiColor(value, 100), VALUE_COLORS[tier], `tier ${tier}`);
    }
    assert.equal(getAnsiColor(10, 10), VALUE_COLORS[9]);
    assert.equal(getAnsiColor(100, 10), VALUE_COLORS[9]);
  });
});

describe('buildHeatmap', () => {
  it('builds a 7x24 grid, aggregates duplicate cells, and computes total and maximum', () => {
    const heatmap = weeklyFixture();

    assert.deepEqual(heatmap.rows, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    assert.deepEqual(heatmap.columns, Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')));
    assert.equal(heatmap.cells.length, 7);
    assert.ok(heatmap.cells.every((row) => row.length === 24));
    assert.deepEqual(heatmap.cells[0][0], { values: 5 });
    assert.deepEqual(heatmap.cells[3][12], { values: 1 });
    assert.deepEqual(heatmap.cells[6][23], { values: 7 });
    assert.deepEqual(heatmap.cells[2][11], { values: 0 });
    assert.equal(heatmap.totalValues, 13);
    assert.equal(heatmap.maxValues, 7);
    assert.equal(heatmap.cells.flat().reduce((sum, cell) => sum + cell.values, 0), 13);
  });
});

describe('buildMonthlyHeatmap', () => {
  it('builds 31 valid day cells, aggregates them, and excludes invalid days', () => {
    const heatmap = buildMonthlyHeatmap([
      { day: 1, values: 2 },
      { day: 1, values: 3 },
      { day: 15, values: 1 },
      { day: 31, values: 7 },
      { day: 0, values: 100 },
      { day: 32, values: 200 },
      { day: -1, values: 300 },
    ]);

    assert.deepEqual(heatmap.rows, ['Day']);
    assert.deepEqual(heatmap.columns, Array.from({ length: 31 }, (_, index) => String(index + 1).padStart(2, '0')));
    assert.equal(heatmap.cells.length, 1);
    assert.equal(heatmap.cells[0].length, 31);
    assert.deepEqual(heatmap.cells[0][0], { values: 5 });
    assert.deepEqual(heatmap.cells[0][14], { values: 1 });
    assert.deepEqual(heatmap.cells[0][30], { values: 7 });
    assert.deepEqual(heatmap.cells[0][1], { values: 0 });
    assert.equal(heatmap.totalValues, 13);
    assert.equal(heatmap.maxValues, 7);
    assert.equal(heatmap.cells[0].reduce((sum, cell) => sum + cell.values, 0), 13);
  });
});

describe('renderHeatmapPanel', () => {
  it('renders title, total, current even-hour styling, and current weekday styling', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 7, 12) });
    const heatmap = weeklyFixture();
    const output = renderHeatmapPanel(heatmap);
    const lines = output.split('\n');
    const evenHours = heatmap.columns.filter((_, index) => index % 2 === 0);
    const expectedHeader = evenHours
      .map((label) => label === '12' ? bold(label) : dim(label))
      .join('  ') + '  ';

    assert.equal(lines[0], '  Values (13 total)');
    assert.equal(lines[1], `      ${expectedHeader}`);
    assert.equal(lines.length, 9);
    heatmap.rows.forEach((label, index) => {
      const expectedLabel = label === 'Wed' ? bold(label) : dim(label);
      assert.ok(lines[index + 2].startsWith(`  ${expectedLabel} `), `${label} styling`);
    });
  });

  it('places an odd-hour marker before the next even hour and honors a custom title', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 7, 13) });
    const heatmap = weeklyFixture();
    const lines = renderHeatmapPanel(heatmap, { title: 'Requests' }).split('\n');
    const evenHeader = heatmap.columns
      .filter((_, index) => index % 2 === 0)
      .map(dim)
      .join('  ') + '  ';
    const expectedHeader = evenHeader.replace(
      `${dim('12')}  ${dim('14')}`,
      `${dim('12')}· ${dim('14')}`,
    );

    assert.equal(lines[0], '  Requests (13 total)');
    assert.equal(lines[1], `      ${expectedHeader}`);
    assert.notEqual(lines[1], `      ${evenHeader}`);
  });

  it('appends the current-hour marker after the final label at hour 23', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 7, 23) });
    const heatmap = weeklyFixture();
    const lines = renderHeatmapPanel(heatmap).split('\n');
    const evenHeader = heatmap.columns
      .filter((_, index) => index % 2 === 0)
      .map(dim)
      .join('  ') + '  ';

    assert.equal(lines[1], `      ${evenHeader.trimEnd()}· `);
  });
});

describe('renderMonthlyHeatmapPanel', () => {
  it('renders title, total, 31 cells, and a bold-white odd current-day label', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 7, 12) });
    const heatmap = monthlyFixture();
    const lines = renderMonthlyHeatmapPanel(heatmap, { title: 'Daily values' }).split('\n');
    const expectedHeader = heatmap.columns
      .filter((_, index) => index % 2 === 0)
      .map((label) => label === '07' ? boldWhite(label) : dim(label))
      .join('  ') + '  ';

    assert.equal(lines[0], '  Daily values (13 total)');
    assert.equal(lines[1], `      ${expectedHeader}`);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].startsWith('  Day '));
    assert.equal(lines[2].split('■').length - 1, 31);
  });

  it('renders 31 cells and marks an even current day before the next odd label', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 8, 12) });
    const heatmap = monthlyFixture();
    const lines = renderMonthlyHeatmapPanel(heatmap).split('\n');
    const oddHeader = heatmap.columns
      .filter((_, index) => index % 2 === 0)
      .map(dim)
      .join('  ') + '  ';
    const expectedHeader = oddHeader.replace(
      `${dim('07')}  ${dim('09')}`,
      `${dim('07')}· ${dim('09')}`,
    );

    assert.equal(lines[0], '  Values (13 total)');
    assert.equal(lines[1], `      ${expectedHeader}`);
    assert.ok(!lines[1].includes(boldWhite('08')));
    assert.equal(lines[2].split('■').length - 1, 31);
  });
});
