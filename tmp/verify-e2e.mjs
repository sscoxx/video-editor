import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8080';
const videoPath = process.env.VIDEO_PATH || path.resolve('tmp/sample.mp4');

const log = (msg) => console.log(`[verify] ${msg}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  log(`Abriendo ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  log('Cargando video de prueba...');
  await page.setInputFiles('#video-input', videoPath);

  await page.waitForFunction(() => {
    const container = document.querySelector('.file-meta');
    if (!container) return false;
    const text = container.textContent || '';
    return text.includes('Archivo:') && text.includes('Duración:') && !text.includes('Leyendo metadata');
  }, null, { timeout: 90_000 });

  log('Probando recorte simple...');
  await page.locator('.mode-switch').getByRole('button', { name: 'Simple' }).click();
  await page.fill('#start-input', '00:00:00');
  await page.fill('#duration-input', '00:00:01');
  await page.getByRole('button', { name: 'Recortar' }).click();

  await page.waitForFunction(() => {
    return (document.body.textContent || '').includes('Proceso single completado');
  }, null, { timeout: 300_000 });

  let outputsCount = await page.locator('.download-list li').count();
  assert(outputsCount >= 1, `Se esperaba >=1 salida en simple, obtenido ${outputsCount}`);
  log(`Recorte simple OK (${outputsCount} salida/s).`);

  log('Probando cortes múltiples...');
  await page.locator('.mode-switch').getByRole('button', { name: 'Múltiple' }).click();

  const rows = page.locator('.multi-cut-row');
  const rowCount = await rows.count();
  assert(rowCount >= 2, `Se esperaban >=2 filas en múltiple, obtenido ${rowCount}`);

  await rows.nth(0).locator('input').nth(0).fill('00:00:00');
  await rows.nth(0).locator('input').nth(1).fill('00:00:01');
  await rows.nth(1).locator('input').nth(0).fill('00:00:01');
  await rows.nth(1).locator('input').nth(1).fill('00:00:02');

  await page.getByRole('button', { name: 'Generar cortes múltiples' }).click();

  await page.waitForFunction(() => {
    return (document.body.textContent || '').includes('Proceso multi completado');
  }, null, { timeout: 300_000 });

  outputsCount = await page.locator('.download-list li').count();
  assert(outputsCount >= 2, `Se esperaban >=2 salidas en múltiple, obtenido ${outputsCount}`);
  log(`Cortes múltiples OK (${outputsCount} salida/s).`);

  log('Probando auto-dividir...');
  await page.locator('.mode-switch').getByRole('button', { name: 'Auto-dividir' }).click();
  await page.fill('#auto-start-input', '00:00:00');
  await page.fill('#clip-length-input', '00:00:01');

  const autoPage = page.locator('.mode-page').nth(1);
  await autoPage.getByRole('button', { name: 'Auto-dividir' }).click();

  await page.waitForFunction(() => {
    return (document.body.textContent || '').includes('Proceso auto completado');
  }, null, { timeout: 300_000 });

  outputsCount = await page.locator('.download-list li').count();
  assert(outputsCount >= 2, `Se esperaban >=2 salidas en auto, obtenido ${outputsCount}`);
  log(`Auto-dividir OK (${outputsCount} salida/s).`);

  log('Verificando logs ffmpeg...');
  const logsText = await page.locator('.logs-box').innerText();
  assert(logsText.includes('[ffmpeg:'), 'No se detectaron logs de ffmpeg en la caja de logs.');

  await page.screenshot({ path: 'tmp/verify-success.png', fullPage: true });
  log('Validación E2E completada correctamente.');
} catch (error) {
  await page.screenshot({ path: 'tmp/verify-fail.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
