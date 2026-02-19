import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const publicFfmpegDir = path.join(projectRoot, 'public', 'ffmpeg');

const filesToCopy = [
  {
    from: path.join(projectRoot, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.js'),
    to: path.join(publicFfmpegDir, 'ffmpeg-core.js')
  },
  {
    from: path.join(projectRoot, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.wasm'),
    to: path.join(publicFfmpegDir, 'ffmpeg-core.wasm')
  },
  {
    from: path.join(projectRoot, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'worker.js'),
    to: path.join(publicFfmpegDir, 'worker.js')
  },
  {
    from: path.join(projectRoot, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'const.js'),
    to: path.join(publicFfmpegDir, 'const.js')
  },
  {
    from: path.join(projectRoot, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'errors.js'),
    to: path.join(publicFfmpegDir, 'errors.js')
  }
];

const exists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const run = async () => {
  await mkdir(publicFfmpegDir, { recursive: true });

  for (const file of filesToCopy) {
    const found = await exists(file.from);

    if (!found) {
      throw new Error(`No se encontró el asset requerido: ${file.from}`);
    }

    await cp(file.from, file.to, { force: true });
  }

  console.log('Assets de ffmpeg copiados a public/ffmpeg');
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
