import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

import { formatSecondsForFfmpeg } from './time';

const FFMPEG_PUBLIC_DIR = '/ffmpeg';

export interface FFmpegLogEvent {
  type: string;
  message: string;
}

export interface FFmpegProgressEvent {
  progress: number;
  time?: number;
}

export interface FFmpegCallbacks {
  onLog?: (event: FFmpegLogEvent) => void;
  onProgress?: (event: FFmpegProgressEvent) => void;
}

export interface CutJob {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  videoFilter?: string;
}

export interface ImageJob {
  inputPath: string;
  outputPath: string;
  videoFilter: string;
  quality?: number;
}

export class BrowserFFmpeg {
  private readonly ffmpeg: FFmpeg;
  private loaded = false;
  private callbacks: FFmpegCallbacks;

  constructor(callbacks: FFmpegCallbacks = {}) {
    this.ffmpeg = new FFmpeg();
    this.callbacks = callbacks;

    this.ffmpeg.on('log', (event) => {
      this.callbacks.onLog?.(event);
    });

    this.ffmpeg.on('progress', (event) => {
      this.callbacks.onProgress?.(event);
    });
  }

  public setCallbacks(callbacks: FFmpegCallbacks): void {
    this.callbacks = callbacks;
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const coreURL = await toBlobURL(`${FFMPEG_PUBLIC_DIR}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${FFMPEG_PUBLIC_DIR}/ffmpeg-core.wasm`, 'application/wasm');

    await this.ffmpeg.load({
      coreURL,
      wasmURL,
      classWorkerURL: `${FFMPEG_PUBLIC_DIR}/worker.js`
    });

    this.loaded = true;
  }

  public async writeInputFile(file: File): Promise<string> {
    const extension = this.extractExtension(file.name);
    const inputPath = `input_${Date.now()}.${extension}`;

    await this.ffmpeg.writeFile(inputPath, await fetchFile(file));

    return inputPath;
  }

  public async transcodeClip(job: CutJob): Promise<Uint8Array> {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      formatSecondsForFfmpeg(job.startSeconds),
      '-i',
      job.inputPath
    ];

    if (job.durationSeconds > 0) {
      args.push('-t', formatSecondsForFfmpeg(job.durationSeconds));
    }

    if (job.videoFilter) {
      args.push('-vf', job.videoFilter);
    }

    args.push(
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      job.outputPath
    );

    const exitCode = await this.ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg finalizó con código ${exitCode} al recodificar video.`);
    }

    return this.readOutputFile(job.outputPath);
  }

  public async transcodeImage(job: ImageJob): Promise<Uint8Array> {
    const exitCode = await this.ffmpeg.exec([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      job.inputPath,
      '-vf',
      job.videoFilter,
      '-frames:v',
      '1',
      '-q:v',
      String(job.quality ?? 2),
      job.outputPath
    ]);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg finalizó con código ${exitCode} al convertir imagen.`);
    }

    return this.readOutputFile(job.outputPath);
  }

  public async deleteFile(path: string): Promise<void> {
    try {
      await this.ffmpeg.deleteFile(path);
    } catch {
      // Ignorar cuando el archivo no existe.
    }
  }

  public terminate(): void {
    this.ffmpeg.terminate();
    this.loaded = false;
  }

  private async readOutputFile(path: string): Promise<Uint8Array> {
    const rawData = await this.ffmpeg.readFile(path);
    await this.deleteFile(path);

    if (typeof rawData === 'string') {
      return new TextEncoder().encode(rawData);
    }

    return rawData;
  }

  private extractExtension(fileName: string): string {
    const parts = fileName.split('.');

    if (parts.length <= 1) {
      return 'mp4';
    }

    const extension = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    return extension || 'mp4';
  }
}
