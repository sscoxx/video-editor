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
    const exitCode = await this.ffmpeg.exec([
      '-ss',
      formatSecondsForFfmpeg(job.startSeconds),
      '-i',
      job.inputPath,
      '-t',
      formatSecondsForFfmpeg(job.durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      job.outputPath
    ]);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg finalizó con código ${exitCode}.`);
    }

    const rawData = await this.ffmpeg.readFile(job.outputPath);
    await this.deleteFile(job.outputPath);

    if (typeof rawData === 'string') {
      return new TextEncoder().encode(rawData);
    }

    return rawData;
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

  private extractExtension(fileName: string): string {
    const parts = fileName.split('.');

    if (parts.length <= 1) {
      return 'mp4';
    }

    const extension = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    return extension || 'mp4';
  }
}
