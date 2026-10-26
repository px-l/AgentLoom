import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
test('100/300/500 节点的实际指针拖拽测量', async ({ page }) => {
  const samples = [];
  for (const count of [100, 300, 500])
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.goto(`/benchmark?nodes=${count}`);
      await expect(page.getByTestId('perf-ready')).toHaveText('ready');
      await expect(page.locator('.react-flow__node')).toHaveCount(count);
      await page.waitForTimeout(300);
      const box = await page.locator('.react-flow__node[data-id="n0"]').boundingBox();
      expect(box).not.toBeNull();
      const x = box!.x + box!.width / 2,
        y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.evaluate(() => window.agentloomPerf!.start());
      await page.mouse.down();
      for (let frame = 0; frame < 60; frame++) {
        await page.mouse.move(x + frame * 3, y + Math.sin(frame / 10) * 35);
        await page.waitForTimeout(12);
      }
      await page.mouse.up();
      await page.waitForTimeout(50);
      const result = await page.evaluate(() => window.agentloomPerf!.finish());
      expect(result.historyEntries).toBe(1);
      expect(result.saveSignals).toBe(1);
      samples.push({ ...result, repeat });
    }
  mkdirSync('../../docs', { recursive: true });
  writeFileSync(
    '../../docs/performance-results.json',
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        platform: os.platform(),
        arch: os.arch(),
        cpu: os.cpus()[0]?.model,
        logicalCPUs: os.cpus().length,
        totalMemoryGiB: Math.round(os.totalmem() / 2 ** 30),
        mode: 'Vite development / Chrome headless / viewport 1440x1000',
        method:
          '3 repeats per graph; 60 real pointer moves, 12ms waits, RAF intervals while dragging, all nodes mounted; no pre-optimization baseline',
        samples,
      },
      null,
      2,
    ),
  );
});
