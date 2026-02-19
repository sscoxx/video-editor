import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8080';
const videoPath = process.env.VIDEO_PATH || path.resolve('tmp/sample.mp4');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

try {
  console.log('[verify-mp4] Abriendo app...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log('[verify-mp4] Cargando MP4...');
  await page.setInputFiles('#video-input', videoPath);

  await page.waitForFunction(() => {
    const meta = document.querySelector('.file-meta');
    return !!meta && (meta.textContent || '').includes('sample.mp4');
  }, null, { timeout: 60_000 });

  await page.fill('#start-input', '00:00:00');
  await page.fill('#duration-input', '00:00:01');
  await page.getByRole('button', { name: 'Recortar' }).click();

  await page.waitForFunction(() => {
    return (document.body.textContent || '').includes('Proceso single completado');
  }, null, { timeout: 300_000 });

  const outputs = await page.locator('.download-list li').count();
  assert(outputs >= 1, `Se esperaba al menos 1 output con MP4, obtenido ${outputs}`);

  const logs = await page.locator('.logs-box').innerText();
  assert(logs.includes('[ffmpeg:'), 'No se detectaron logs ffmpeg en prueba MP4.');

  await page.screenshot({ path: 'tmp/verify-mp4-success.png', fullPage: true });
  console.log('[verify-mp4] Recorte simple MP4 OK.');
} catch (error) {
  await page.screenshot({ path: 'tmp/verify-mp4-fail.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
