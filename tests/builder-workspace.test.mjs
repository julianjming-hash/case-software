import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderPanelLayout, PANEL } from '../src/client/builder-workspace.mjs';

const sum = layout => layout.single ? layout.centre : layout.outline + layout.centre + layout.tools + (layout.outline ? PANEL.gap : 0) + (layout.tools ? PANEL.gap : 0);

test('[AS-131] Builder regions keep a 640px usable canvas, collapse Tools first and use one region below the Outline+canvas minimum', () => {
  // The canvas column is 640px usable plus the sheet's maximum inline padding.
  assert.equal(PANEL.centre, 640 + 2 * 32);
  assert.deepEqual(builderPanelLayout(1600), { single: false, outline: 204, tools: 284, centre: 1600 - 204 - 284 - 24 });
  assert.deepEqual([builderPanelLayout(1216).outline, builderPanelLayout(1216).tools], [204, 284]);
  // Below the defaults the Outline yields first, then Tools sit at their minimum, then Tools collapse.
  assert.deepEqual([builderPanelLayout(1176).outline, builderPanelLayout(1176).tools], [188, 260]);
  assert.deepEqual([builderPanelLayout(1152).outline, builderPanelLayout(1152).tools], [164, 260]);
  assert.deepEqual([builderPanelLayout(1151).outline, builderPanelLayout(1151).tools], [204, 0]);
  assert.equal(builderPanelLayout(880).single, false);
  assert.equal(builderPanelLayout(879).single, true);
  for (const width of [320, 390, 768, 880, 1024, 1152, 1280, 1366, 1600, 1920, 2560]) for (const outline of [0, 100, 204, 999]) for (const tools of [0, 284, 999]) {
    const layout = builderPanelLayout(width, { outline, tools });
    assert.equal(sum(layout), width, `${width}/${outline}/${tools}`);
    if (!layout.single) {
      assert.ok(layout.centre >= PANEL.centre, `${width} centre ${layout.centre}`);
      assert.ok(layout.outline >= 164 && layout.outline <= 280);
      assert.ok(layout.tools === 0 || (layout.tools >= 260 && layout.tools <= 360));
      // Widening the Outline never silently collapses Tools that fit at their minimum.
      if (width >= 1152) assert.ok(layout.tools >= 260, `${width}/${outline} lost Tools`);
    }
  }
});

test('[AS-131] manual collapse is a preference the layout honours at any width', () => {
  assert.equal(builderPanelLayout(2560, { hideTools: true }).tools, 0);
  assert.equal(builderPanelLayout(2560, { hideOutline: true }).outline, 0);
  assert.equal(builderPanelLayout(2560, { hideOutline: true }).centre, 2560 - 284 - 12);
  // A remembered wide Outline is clamped, not stored, so the canvas keeps its minimum on a narrow window.
  assert.equal(builderPanelLayout(900, { outline: 280 }).outline, 900 - 12 - 704);
  assert.equal(builderPanelLayout(1200, { outline: 999 }).outline, 1200 - 12 - 704 - 12 - 260);
  assert.equal(builderPanelLayout(2560, { outline: 280 }).outline, 280);
});
