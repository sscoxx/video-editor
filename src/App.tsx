import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BrowserFFmpeg } from './lib/ffmpeg';
import { clamp, formatBytes, formatSecondsToTime, parseTimeToSeconds } from './lib/time';
import './App.css';

interface OutputClip {
  name: string;
  url: string;
  sizeBytes: number;
  startSeconds: number;
  durationSeconds: number;
}

interface AutoJob {
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
}

type ProcessingMode = 'idle' | 'single' | 'auto';

interface ProgressContext {
  mode: ProcessingMode;
  clipIndex: number;
  totalClips: number;
}

interface SingleCutValidation {
  startSeconds: number;
  durationSeconds: number;
  notice?: string;
}

const MAX_LOG_LINES = 250;
const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;
const DURATION_EPSILON = 0.001;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Se produjo un error inesperado.';
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const isVideoFile = (file: File): boolean => {
  return file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4');
};

const buildAutoJobs = (startSeconds: number, clipLengthSeconds: number, totalDurationSeconds: number): AutoJob[] => {
  const jobs: AutoJob[] = [];
  let clipIndex = 0;

  for (let cursor = startSeconds; cursor < totalDurationSeconds - DURATION_EPSILON; cursor += clipLengthSeconds) {
    const remaining = totalDurationSeconds - cursor;
    const durationSeconds = Math.min(clipLengthSeconds, remaining);
    const outputPath = `clip_${String(clipIndex).padStart(3, '0')}.mp4`;

    jobs.push({
      outputPath,
      startSeconds: cursor,
      durationSeconds
    });

    clipIndex += 1;
  }

  return jobs;
};

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoDurationSeconds, setVideoDurationSeconds] = useState<number | null>(null);

  const [startInput, setStartInput] = useState('00:00:00');
  const [durationInput, setDurationInput] = useState('00:00:34');

  const [autoStartInput, setAutoStartInput] = useState('');
  const [clipLengthInput, setClipLengthInput] = useState('00:00:34');

  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCoreLoaded, setIsCoreLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputClip[]>([]);

  const ffmpegRef = useRef<BrowserFFmpeg | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const outputsRef = useRef<OutputClip[]>([]);
  const progressContextRef = useRef<ProgressContext>({
    mode: 'idle',
    clipIndex: 0,
    totalClips: 1
  });

  const appendLogLine = useCallback((entry: string) => {
    setLogs((previous) => {
      const next = [...previous, entry];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  const replaceOutputs = useCallback((nextOutputs: OutputClip[]) => {
    outputsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    outputsRef.current = nextOutputs;
    setOutputs(nextOutputs);
  }, []);

  const appendOutput = useCallback((clip: OutputClip) => {
    const nextOutputs = [...outputsRef.current, clip];
    outputsRef.current = nextOutputs;
    setOutputs(nextOutputs);
  }, []);

  const setPreviewSource = useCallback((nextUrl: string | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }

    previewUrlRef.current = nextUrl;
    setVideoUrl(nextUrl ?? '');
  }, []);

  useEffect(() => {
    const processor = new BrowserFFmpeg({
      onLog: (event) => {
        appendLogLine(`[ffmpeg:${event.type}] ${event.message}`);
      },
      onProgress: (event) => {
        const context = progressContextRef.current;

        if (context.mode === 'idle') {
          return;
        }

        if (context.mode === 'single') {
          setProgress(clamp(event.progress * 100, 0, 100));
          return;
        }

        const normalized = ((context.clipIndex + event.progress) / Math.max(context.totalClips, 1)) * 100;
        setProgress(clamp(normalized, 0, 100));
      }
    });

    ffmpegRef.current = processor;

    return () => {
      processor.terminate();
    };
  }, [appendLogLine]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }

      outputsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const parsedStartSeconds = useMemo(() => parseTimeToSeconds(startInput), [startInput]);
  const sliderValue = useMemo(() => {
    if (videoDurationSeconds === null) {
      return 0;
    }

    return clamp(parsedStartSeconds ?? 0, 0, videoDurationSeconds);
  }, [parsedStartSeconds, videoDurationSeconds]);

  const clearRunState = useCallback(() => {
    setError(null);
    setStatus('');
    setProgress(0);
    setLogs([]);
  }, []);

  const handleIncomingFile = useCallback(
    (file: File) => {
      if (!isVideoFile(file)) {
        setError('Selecciona un archivo de video válido (preferentemente MP4).');
        return;
      }

      clearRunState();
      replaceOutputs([]);

      setSelectedFile(file);
      setVideoDurationSeconds(null);

      setStartInput('00:00:00');
      setDurationInput('00:00:34');
      setAutoStartInput('');
      setClipLengthInput('00:00:34');

      setWarning(
        file.size >= LARGE_FILE_THRESHOLD
          ? 'Archivo grande detectado. El procesamiento en el navegador puede tardar bastante y consumir mucha memoria.'
          : null
      );

      const objectUrl = URL.createObjectURL(file);
      setPreviewSource(objectUrl);
    },
    [clearRunState, replaceOutputs, setPreviewSource]
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file) {
      handleIncomingFile(file);
    }

    event.target.value = '';
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      handleIncomingFile(file);
    }
  };

  const validateSingleCut = (): SingleCutValidation | null => {
    const fail = (message: string): null => {
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    };

    if (!selectedFile) {
      return fail('Carga un video primero.');
    }

    const startSeconds = parseTimeToSeconds(startInput);

    if (startSeconds === null) {
      return fail('Start time inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales (punto o coma).');
    }

    const durationSeconds = parseTimeToSeconds(durationInput);

    if (durationSeconds === null) {
      return fail('Duration inválida. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales (punto o coma).');
    }

    if (startSeconds < 0) {
      return fail('Start time debe ser mayor o igual que 0.');
    }

    if (durationSeconds <= 0) {
      return fail('Duration debe ser mayor que 0.');
    }

    let effectiveDuration = durationSeconds;
    let notice: string | undefined;

    if (videoDurationSeconds !== null) {
      if (startSeconds >= videoDurationSeconds) {
        return fail('Start time está fuera de la duración del video.');
      }

      const remaining = videoDurationSeconds - startSeconds;

      if (remaining <= DURATION_EPSILON) {
        return fail('No hay contenido disponible desde ese Start time.');
      }

      if (durationSeconds > remaining + DURATION_EPSILON) {
        effectiveDuration = remaining;
        notice = `Duration ajustada automáticamente a ${formatSecondsToTime(effectiveDuration)} para no exceder el video.`;
        appendLogLine(`[ui] ${notice}`);
      }
    }

    return { startSeconds, durationSeconds: effectiveDuration, notice };
  };

  const validateAutoSplit = (): { jobs: AutoJob[] } | null => {
    if (!selectedFile) {
      setError('Carga un video primero.');
      return null;
    }

    if (videoDurationSeconds === null) {
      setError('No se pudo leer la duración del video. Reproduce o recarga el archivo para obtener metadata.');
      return null;
    }

    const startSeconds = autoStartInput.trim() ? parseTimeToSeconds(autoStartInput) : 0;

    if (startSeconds === null) {
      const message = 'Auto Start inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales (punto o coma).';
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    }

    const clipLengthSeconds = parseTimeToSeconds(clipLengthInput);

    if (clipLengthSeconds === null) {
      const message = 'Clip length inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales (punto o coma).';
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    }

    if (startSeconds < 0) {
      setError('Auto Start debe ser mayor o igual que 0.');
      return null;
    }

    if (clipLengthSeconds <= 0) {
      setError('Clip length debe ser mayor que 0.');
      return null;
    }

    if (startSeconds >= videoDurationSeconds) {
      setError('Auto Start está fuera de la duración del video.');
      return null;
    }

    const jobs = buildAutoJobs(startSeconds, clipLengthSeconds, videoDurationSeconds);

    if (jobs.length === 0) {
      setError('No hay clips para generar con esos parámetros.');
      return null;
    }

    return { jobs };
  };

  const loadCore = useCallback(async (): Promise<boolean> => {
    const processor = ffmpegRef.current;

    if (!processor) {
      setError('No se pudo inicializar ffmpeg.');
      return false;
    }

    try {
      setError(null);
      setStatus('Cargando ffmpeg.wasm...');
      await processor.load();
      setIsCoreLoaded(true);
      setStatus('Motor ffmpeg listo.');
      return true;
    } catch (loadError) {
      setError(toErrorMessage(loadError));
      setStatus('Error al cargar ffmpeg.wasm.');
      return false;
    }
  }, []);

  const handleLoadCore = async () => {
    if (isCoreLoaded) {
      return;
    }

    setLogs([]);
    await loadCore();
  };

  const handleTrim = async () => {
    const valid = validateSingleCut();

    if (!valid) {
      return;
    }

    const processor = ffmpegRef.current;

    if (!processor || !selectedFile) {
      setError('No se pudo iniciar ffmpeg.');
      return;
    }

    clearRunState();
    replaceOutputs([]);
    setIsProcessing(true);

    progressContextRef.current = {
      mode: 'single',
      clipIndex: 0,
      totalClips: 1
    };

    let inputPath: string | null = null;

    try {
      const loaded = await loadCore();

      if (!loaded) {
        return;
      }

      inputPath = await processor.writeInputFile(selectedFile);

      setStatus('Recodificando clip...');
      appendLogLine(
        `[ui] Recorte solicitado: start=${formatSecondsToTime(valid.startSeconds, true)} duration=${formatSecondsToTime(
          valid.durationSeconds,
          true
        )}`
      );

      if (valid.notice) {
        setWarning(valid.notice);
      }

      const outputName = 'output.mp4';
      const outputBytes = await processor.transcodeClip({
        inputPath,
        outputPath: outputName,
        startSeconds: valid.startSeconds,
        durationSeconds: valid.durationSeconds
      });

      const outputUrl = URL.createObjectURL(new Blob([toArrayBuffer(outputBytes)], { type: 'video/mp4' }));

      appendOutput({
        name: outputName,
        url: outputUrl,
        sizeBytes: outputBytes.byteLength,
        startSeconds: valid.startSeconds,
        durationSeconds: valid.durationSeconds
      });

      setProgress(100);
      setStatus('Recorte completado.');
    } catch (trimError) {
      setError(toErrorMessage(trimError));
      setStatus('No se pudo completar el recorte.');
    } finally {
      if (inputPath) {
        await processor.deleteFile(inputPath);
      }

      progressContextRef.current.mode = 'idle';
      setIsProcessing(false);
    }
  };

  const handleAutoSplit = async () => {
    const valid = validateAutoSplit();

    if (!valid) {
      return;
    }

    const processor = ffmpegRef.current;

    if (!processor || !selectedFile) {
      setError('No se pudo iniciar ffmpeg.');
      return;
    }

    clearRunState();
    replaceOutputs([]);
    setIsProcessing(true);

    progressContextRef.current = {
      mode: 'auto',
      clipIndex: 0,
      totalClips: valid.jobs.length
    };

    let inputPath: string | null = null;

    try {
      const loaded = await loadCore();

      if (!loaded) {
        return;
      }

      inputPath = await processor.writeInputFile(selectedFile);

      for (let index = 0; index < valid.jobs.length; index += 1) {
        const job = valid.jobs[index];
        progressContextRef.current.clipIndex = index;

        setStatus(`Recodificando clip ${index + 1} de ${valid.jobs.length}...`);

        const outputBytes = await processor.transcodeClip({
          inputPath,
          outputPath: job.outputPath,
          startSeconds: job.startSeconds,
          durationSeconds: job.durationSeconds
        });

        const outputUrl = URL.createObjectURL(new Blob([toArrayBuffer(outputBytes)], { type: 'video/mp4' }));

        appendOutput({
          name: job.outputPath,
          url: outputUrl,
          sizeBytes: outputBytes.byteLength,
          startSeconds: job.startSeconds,
          durationSeconds: job.durationSeconds
        });
      }

      setProgress(100);
      setStatus(`Auto-división completada. ${valid.jobs.length} clips generados.`);
    } catch (splitError) {
      const partial = outputsRef.current.length;
      const partialMessage = partial > 0 ? ` Se generaron ${partial} clips antes del error.` : '';

      setError(`${toErrorMessage(splitError)}${partialMessage}`);
      setStatus('Auto-división interrumpida.');
    } finally {
      if (inputPath) {
        await processor.deleteFile(inputPath);
      }

      progressContextRef.current.mode = 'idle';
      setIsProcessing(false);
    }
  };

  const handlePreviewFromStart = async () => {
    const player = videoRef.current;

    if (!player) {
      return;
    }

    const startSeconds = parseTimeToSeconds(startInput);

    if (startSeconds === null || startSeconds < 0) {
      setError('Start time inválido para previsualización.');
      return;
    }

    if (videoDurationSeconds !== null && startSeconds > videoDurationSeconds) {
      setError('Start time supera la duración del video.');
      return;
    }

    setError(null);

    player.currentTime = startSeconds;

    try {
      await player.play();
    } catch (playError) {
      setError(`No se pudo iniciar la reproducción: ${toErrorMessage(playError)}`);
    }
  };

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);

    if (!Number.isFinite(value) || value < 0) {
      return;
    }

    const hasMillis = Math.abs(value - Math.round(value)) > DURATION_EPSILON;
    setStartInput(formatSecondsToTime(value, hasMillis));
  };

  const handleMetadataLoaded = () => {
    const player = videoRef.current;

    if (!player || !Number.isFinite(player.duration)) {
      setVideoDurationSeconds(null);
      return;
    }

    const durationSeconds = player.duration;
    setVideoDurationSeconds(durationSeconds);

    const parsedStart = parseTimeToSeconds(startInput);

    if (parsedStart !== null && parsedStart > durationSeconds) {
      setStartInput(formatSecondsToTime(durationSeconds, false));
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Mini Video Cutter</h1>
        <p>
          Recorte y auto-división en el navegador con ffmpeg.wasm, siempre recodificando en H.264 + AAC.
        </p>
      </header>

      <section
        className={`dropzone ${isDragging ? 'dropzone--active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <label htmlFor="video-input" className="file-button">
          Cargar video
        </label>
        <input id="video-input" type="file" accept="video/mp4,video/*" onChange={handleFileInput} />
        <p>Arrastra un video aquí o usa el botón.</p>
      </section>

      {selectedFile && (
        <section className="file-meta">
          <div>
            <strong>Archivo:</strong> {selectedFile.name}
          </div>
          <div>
            <strong>Tamaño:</strong> {formatBytes(selectedFile.size)}
          </div>
          <div>
            <strong>Duración:</strong>{' '}
            {videoDurationSeconds === null ? 'Leyendo metadata...' : formatSecondsToTime(videoDurationSeconds)}
          </div>
        </section>
      )}

      {warning && <div className="message message--warning">{warning}</div>}
      {error && <div className="message message--error">{error}</div>}

      <section className="panel">
        <h2>Preview</h2>
        <video
          ref={videoRef}
          src={videoUrl || undefined}
          controls
          onLoadedMetadata={handleMetadataLoaded}
          className="video-preview"
        />
      </section>

      <section className="panel controls-grid">
        <h2>Recorte simple</h2>

        <label htmlFor="start-input">Start time</label>
        <input
          id="start-input"
          value={startInput}
          onChange={(event) => setStartInput(event.target.value)}
          placeholder="00:00:00 o 0.0"
        />

        {videoDurationSeconds !== null && (
          <input
            type="range"
            min={0}
            max={videoDurationSeconds}
            step={0.1}
            value={sliderValue}
            onChange={handleSliderChange}
          />
        )}

        <button type="button" onClick={handlePreviewFromStart} disabled={!selectedFile || isProcessing}>
          Previsualizar desde Start
        </button>

        <label htmlFor="duration-input">Duration</label>
        <input
          id="duration-input"
          value={durationInput}
          onChange={(event) => setDurationInput(event.target.value)}
          placeholder="00:00:34 o 34"
        />

        <button type="button" onClick={handleTrim} disabled={!selectedFile || isProcessing}>
          Recortar
        </button>
      </section>

      <section className="panel controls-grid">
        <h2>Auto-dividir</h2>

        <label htmlFor="auto-start-input">Start opcional</label>
        <input
          id="auto-start-input"
          value={autoStartInput}
          onChange={(event) => setAutoStartInput(event.target.value)}
          placeholder="vacío = 00:00:00"
        />

        <label htmlFor="clip-length-input">Clip length</label>
        <input
          id="clip-length-input"
          value={clipLengthInput}
          onChange={(event) => setClipLengthInput(event.target.value)}
          placeholder="00:00:34"
        />

        <button
          type="button"
          onClick={handleAutoSplit}
          disabled={!selectedFile || isProcessing || videoDurationSeconds === null}
        >
          Auto-dividir
        </button>
      </section>

      <section className="panel actions-row">
        <button type="button" onClick={handleLoadCore} disabled={isProcessing || isCoreLoaded}>
          {isCoreLoaded ? 'Motor ffmpeg listo' : 'Cargar motor ffmpeg'}
        </button>
      </section>

      <section className="panel">
        <h2>Progreso</h2>
        <div className="progress-row">
          <progress value={progress} max={100} />
          <span>{Math.round(progress)}%</span>
        </div>
        <p className="status-text">{status || 'Esperando acción.'}</p>
      </section>

      <section className="panel">
        <h2>Descargas</h2>
        {outputs.length === 0 ? (
          <p>Aún no hay archivos generados.</p>
        ) : (
          <ul className="download-list">
            {outputs.map((clip) => (
              <li key={`${clip.name}-${clip.startSeconds}-${clip.durationSeconds}`}>
                <div>
                  <strong>{clip.name}</strong>
                  <span>
                    {formatSecondsToTime(clip.startSeconds)} - {formatSecondsToTime(clip.startSeconds + clip.durationSeconds)}
                  </span>
                  <span>{formatBytes(clip.sizeBytes)}</span>
                </div>
                <a href={clip.url} download={clip.name}>
                  Descargar
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Logs ffmpeg</h2>
        <div className="logs-toolbar">
          <button type="button" onClick={() => setLogs([])} disabled={logs.length === 0}>
            Limpiar logs
          </button>
        </div>
        <pre className="logs-box">{logs.length === 0 ? 'Sin logs todavía.' : logs.join('\n')}</pre>
      </section>
    </main>
  );
}

export default App;
