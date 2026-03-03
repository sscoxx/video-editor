import { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

import { BrowserFFmpeg } from './lib/ffmpeg';
import { clamp, formatBytes, formatSecondsToTime, parseTimeToSeconds } from './lib/time';
import './App.css';

interface OutputClip {
  id: string;
  name: string;
  url: string;
  blob: Blob;
  sizeBytes: number;
  startSeconds: number;
  durationSeconds: number;
  actualDurationSeconds: number | null;
  verifiedPlayable: boolean;
  verificationError?: string;
}

interface OutputImage {
  id: string;
  name: string;
  sourceName: string;
  url: string;
  blob: Blob;
  sizeBytes: number;
}

interface ClipJob {
  outputName: string;
  startSeconds: number;
  durationSeconds: number;
  label: string;
  videoFilter?: string;
}

interface MultiCutInput {
  id: number;
  startInput: string;
  endInput: string;
}

type ProcessingMode = 'idle' | 'single' | 'auto' | 'multi' | 'instagram' | 'images';

type MarkerTarget = 'single-start' | 'single-end' | 'multi-start' | 'multi-end';
const MODE_TABS = ['simple', 'auto', 'multi', 'instagram', 'images'] as const;
type ModeTab = (typeof MODE_TABS)[number];

interface TimelineSelection {
  startSeconds: number;
  endSeconds: number;
  startTarget: MarkerTarget;
  endTarget: MarkerTarget;
  label: string;
}

interface ProgressContext {
  mode: ProcessingMode;
  clipIndex: number;
  totalClips: number;
}

interface JobValidation {
  jobs: ClipJob[];
  notices: string[];
}

interface VerificationResult {
  playable: boolean;
  durationSeconds: number | null;
  errorMessage?: string;
}

interface HistoryClipSummary {
  name: string;
  sizeBytes: number;
  startSeconds: number;
  durationSeconds: number;
  actualDurationSeconds: number | null;
  verifiedPlayable: boolean;
}

interface SessionHistoryEntry {
  id: string;
  createdAt: number;
  sourceFileName: string;
  mode: Exclude<ProcessingMode, 'idle'>;
  namePattern: string;
  outputCount: number;
  totalSizeBytes: number;
  clips: HistoryClipSummary[];
  multiCutsTemplate?: Array<{ startInput: string; endInput: string }>;
}

const MAX_LOG_LINES = 300;
const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;
const DURATION_EPSILON = 0.001;
const DEFAULT_MULTI_CUT_COUNT = 2;
const HISTORY_KEY = 'mini_video_cutter_history_v1';
const HISTORY_LIMIT = 20;
const DEFAULT_NAME_PATTERN = '{video}_{idx}_{start}_{end}.mp4';
const INSTAGRAM_4X5_FILTER =
  'scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

const toErrorMessage = (error: unknown): string => {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error instanceof Error) {
    if (error.message.includes('called FFmpeg.terminate()')) {
      return 'El motor ffmpeg se reinició durante la operación.';
    }

    return error.message;
  }

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }

  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;

    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      // Ignorar errores de serialización.
    }
  }

  return 'Se produjo un error inesperado.';
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const blobToUint8Array = async (blob: Blob): Promise<Uint8Array> => {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
};

const loadImageElementFromFile = async (file: File): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('No se pudo leer la imagen seleccionada.'));
    };

    image.src = objectUrl;
  });
};

const convertImageToInstagramJpegBytes = async (file: File): Promise<Uint8Array> => {
  const image = await loadImageElementFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('No se pudo inicializar el render de imagen en el navegador.');
  }

  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);

  const safeWidth = Math.max(image.naturalWidth || image.width, 1);
  const safeHeight = Math.max(image.naturalHeight || image.height, 1);
  const scale = Math.max(canvas.width / safeWidth, canvas.height / safeHeight);
  const drawWidth = safeWidth * scale;
  const drawHeight = safeHeight * scale;
  const drawX = (canvas.width - drawWidth) / 2;
  const drawY = (canvas.height - drawHeight) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92);
  });

  if (!blob) {
    throw new Error('No se pudo exportar la imagen convertida.');
  }

  return blobToUint8Array(blob);
};

const isVideoFile = (file: File): boolean => {
  return file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4');
};

const isSupportedImageFile = (file: File): boolean => {
  if (file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp') {
    return true;
  }

  return /\.(jpe?g|png|webp)$/i.test(file.name);
};

const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}_${Math.round(Math.random() * 1_000_000)}`;
};

const createMultiCutInputs = (count = DEFAULT_MULTI_CUT_COUNT): MultiCutInput[] =>
  Array.from({ length: count }, (_, index) => ({
    id: Date.now() + index + Math.round(Math.random() * 10_000),
    startInput: index === 0 ? '00:00:00' : '',
    endInput: ''
  }));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeFileName = (value: string): string => {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '');

  return cleaned || 'clip';
};

const baseNameFromFile = (fileName: string): string => {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return 'video';
  }

  return trimmed.replace(/\.[^.]+$/, '') || 'video';
};

const formatSecondsForName = (seconds: number): string => {
  return formatSecondsToTime(Math.max(seconds, 0), true).replace(/[.:]/g, '-');
};

const buildOutputName = (
  pattern: string,
  sourceName: string,
  index: number,
  startSeconds: number,
  durationSeconds: number
): string => {
  const safePattern = pattern.trim() || DEFAULT_NAME_PATTERN;
  const endSeconds = startSeconds + durationSeconds;
  const idx = String(index).padStart(3, '0');

  const rawName = safePattern
    .replace(/\{video\}/g, sanitizeFileName(baseNameFromFile(sourceName)))
    .replace(/\{idx\}/g, idx)
    .replace(/\{start\}/g, formatSecondsForName(startSeconds))
    .replace(/\{end\}/g, formatSecondsForName(endSeconds))
    .replace(/\{duration\}/g, formatSecondsForName(durationSeconds));

  const normalized = sanitizeFileName(rawName);
  return normalized.toLowerCase().endsWith('.mp4') ? normalized : `${normalized}.mp4`;
};

const buildInstagramOutputName = (sourceName: string): string => {
  const base = sanitizeFileName(baseNameFromFile(sourceName));
  const safeBase = base || 'video';
  return `${safeBase}_ig_4x5.mp4`;
};

const buildImageBatchOutputName = (sourceName: string, duplicateIndex = 0): string => {
  const base = sanitizeFileName(baseNameFromFile(sourceName));
  const safeBase = base || 'image';
  const suffix = duplicateIndex > 0 ? `_${String(duplicateIndex + 1).padStart(2, '0')}` : '';
  return `${safeBase}${suffix}.jpg`;
};

const normalizeVideoOutputName = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  const cleaned = trimmed ? sanitizeFileName(trimmed) : '';
  const safeValue = cleaned || fallback;
  return safeValue.toLowerCase().endsWith('.mp4') ? safeValue : `${safeValue}.mp4`;
};

const formatEta = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }

  return formatSecondsToTime(seconds, false);
};

const isSingleClipMode = (mode: ProcessingMode): boolean => {
  return mode === 'single' || mode === 'instagram';
};

const modeLabel = (mode: ProcessingMode): string => {
  if (mode === 'single') {
    return 'Simple';
  }

  if (mode === 'auto') {
    return 'Auto-dividir';
  }

  if (mode === 'multi') {
    return 'Múltiple';
  }

  if (mode === 'instagram') {
    return 'Instagram 4:5';
  }

  if (mode === 'images') {
    return 'Imágenes 4:5';
  }

  return '-';
};

const markerTargetLabel = (target: MarkerTarget): string => {
  if (target === 'single-start') {
    return 'Inicio simple';
  }

  if (target === 'single-end') {
    return 'Fin simple';
  }

  if (target === 'multi-start') {
    return 'Inicio corte activo';
  }

  return 'Fin corte activo';
};

const parseStoredHistory = (raw: string | null): SessionHistoryEntry[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is SessionHistoryEntry => {
      return (
        item &&
        typeof item.id === 'string' &&
        typeof item.createdAt === 'number' &&
        typeof item.sourceFileName === 'string' &&
        typeof item.mode === 'string' &&
        Array.isArray(item.clips)
      );
    });
  } catch {
    return [];
  }
};

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoDurationSeconds, setVideoDurationSeconds] = useState<number | null>(null);

  const [startInput, setStartInput] = useState('00:00:00');
  const [durationInput, setDurationInput] = useState('00:00:34');

  const [autoStartInput, setAutoStartInput] = useState('');
  const [clipLengthInput, setClipLengthInput] = useState('00:00:34');

  const [outputNamePattern, setOutputNamePattern] = useState(DEFAULT_NAME_PATTERN);
  const [instagramOutputName, setInstagramOutputName] = useState('video_ig_4x5.mp4');
  const [imageBatchFiles, setImageBatchFiles] = useState<File[]>([]);
  const [multiCuts, setMultiCuts] = useState<MultiCutInput[]>(() => createMultiCutInputs());
  const [activeMultiCutId, setActiveMultiCutId] = useState<number | null>(null);
  const [draggingCutId, setDraggingCutId] = useState<number | null>(null);
  const [activeModeTab, setActiveModeTab] = useState<ModeTab>('simple');

  const [markerTarget, setMarkerTarget] = useState<MarkerTarget>('single-start');
  const [activeDragTarget, setActiveDragTarget] = useState<MarkerTarget | null>(null);
  const [timelineCursorSeconds, setTimelineCursorSeconds] = useState(0);
  const [rangeLoop, setRangeLoop] = useState<{ start: number; end: number; cutId: number } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCoreLoading, setIsCoreLoading] = useState(false);
  const [isCoreLoaded, setIsCoreLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputClip[]>([]);
  const [imageOutputs, setImageOutputs] = useState<OutputImage[]>([]);
  const [history, setHistory] = useState<SessionHistoryEntry[]>([]);

  const [currentMode, setCurrentMode] = useState<ProcessingMode>('idle');
  const [currentClipNumber, setCurrentClipNumber] = useState(0);
  const [currentClipTotal, setCurrentClipTotal] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [currentClipElapsedSeconds, setCurrentClipElapsedSeconds] = useState<number | null>(null);

  const [queuePaused, setQueuePaused] = useState(false);
  const [queueCancelRequested, setQueueCancelRequested] = useState(false);

  const ffmpegRef = useRef<BrowserFFmpeg | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const coreLoadPromiseRef = useRef<Promise<boolean> | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const outputsRef = useRef<OutputClip[]>([]);
  const imageOutputsRef = useRef<OutputImage[]>([]);

  const progressContextRef = useRef<ProgressContext>({
    mode: 'idle',
    clipIndex: 0,
    totalClips: 1
  });

  const queueControlRef = useRef({ paused: false, cancelled: false });
  const timingRef = useRef({
    runStartedAt: 0,
    clipStartedAt: 0,
    completedClipSeconds: [] as number[]
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

  const replaceImageOutputs = useCallback((nextOutputs: OutputImage[]) => {
    imageOutputsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    imageOutputsRef.current = nextOutputs;
    setImageOutputs(nextOutputs);
  }, []);

  const appendImageOutput = useCallback((output: OutputImage) => {
    const nextOutputs = [...imageOutputsRef.current, output];
    imageOutputsRef.current = nextOutputs;
    setImageOutputs(nextOutputs);
  }, []);

  const setPreviewSource = useCallback((nextUrl: string | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }

    previewUrlRef.current = nextUrl;
    setVideoUrl(nextUrl ?? '');
  }, []);

  const activeMultiCut = useMemo(
    () => (activeMultiCutId === null ? null : multiCuts.find((item) => item.id === activeMultiCutId) ?? null),
    [activeMultiCutId, multiCuts]
  );

  const parsedStartSeconds = useMemo(() => {
    const trimmed = startInput.trim();
    return trimmed ? parseTimeToSeconds(trimmed) : 0;
  }, [startInput]);
  const parsedDurationSeconds = useMemo(() => parseTimeToSeconds(durationInput), [durationInput]);

  const parsedActiveStartSeconds = useMemo(() => {
    if (!activeMultiCut) {
      return null;
    }

    return parseTimeToSeconds(activeMultiCut.startInput);
  }, [activeMultiCut]);

  const parsedActiveEndSeconds = useMemo(() => {
    if (!activeMultiCut) {
      return null;
    }

    return parseTimeToSeconds(activeMultiCut.endInput);
  }, [activeMultiCut]);

  const downloadableOutputs = useMemo(
    () => outputs.filter((clip) => clip.verifiedPlayable),
    [outputs]
  );

  const activeModeIndex = useMemo(() => MODE_TABS.indexOf(activeModeTab), [activeModeTab]);

  const singleRange = useMemo(() => {
    if (parsedStartSeconds === null) {
      return null;
    }

    const durationCap = videoDurationSeconds ?? Number.POSITIVE_INFINITY;
    const startSeconds = clamp(parsedStartSeconds, 0, durationCap);
    const hasDurationInput = durationInput.trim().length > 0;
    let effectiveDuration = parsedDurationSeconds;

    if (!hasDurationInput && videoDurationSeconds !== null) {
      effectiveDuration = Math.max(videoDurationSeconds - startSeconds, 0);
    }

    if (effectiveDuration === null || effectiveDuration <= DURATION_EPSILON) {
      return null;
    }

    const endSeconds = clamp(startSeconds + effectiveDuration, startSeconds + DURATION_EPSILON, durationCap);

    return {
      startSeconds,
      endSeconds
    };
  }, [durationInput, parsedDurationSeconds, parsedStartSeconds, videoDurationSeconds]);

  const activeMultiRange = useMemo(() => {
    if (parsedActiveStartSeconds === null || parsedActiveEndSeconds === null) {
      return null;
    }

    const durationCap = videoDurationSeconds ?? Number.POSITIVE_INFINITY;
    const startSeconds = clamp(parsedActiveStartSeconds, 0, durationCap);
    const endSeconds = clamp(parsedActiveEndSeconds, startSeconds + DURATION_EPSILON, durationCap);

    if (endSeconds <= startSeconds + DURATION_EPSILON) {
      return null;
    }

    return {
      startSeconds,
      endSeconds
    };
  }, [parsedActiveEndSeconds, parsedActiveStartSeconds, videoDurationSeconds]);

  const timelineSelection = useMemo<TimelineSelection | null>(() => {
    if (videoDurationSeconds === null || videoDurationSeconds <= 0) {
      return null;
    }

    if (activeModeTab === 'simple' && singleRange) {
      return {
        startSeconds: singleRange.startSeconds,
        endSeconds: singleRange.endSeconds,
        startTarget: 'single-start',
        endTarget: 'single-end',
        label: 'Recorte simple'
      };
    }

    if (activeModeTab === 'multi' && activeMultiRange && activeMultiCutId !== null) {
      return {
        startSeconds: activeMultiRange.startSeconds,
        endSeconds: activeMultiRange.endSeconds,
        startTarget: 'multi-start',
        endTarget: 'multi-end',
        label: `Corte activo #${Math.max(
          1,
          multiCuts.findIndex((item) => item.id === activeMultiCutId) + 1
        )}`
      };
    }

    return null;
  }, [activeModeTab, activeMultiCutId, activeMultiRange, multiCuts, singleRange, videoDurationSeconds]);

  const timelineView = useMemo(() => {
    if (videoDurationSeconds === null || videoDurationSeconds <= 0) {
      return {
        startSeconds: 0,
        endSeconds: 1
      };
    }

    if (!timelineSelection) {
      return {
        startSeconds: 0,
        endSeconds: videoDurationSeconds
      };
    }

    const span = Math.max(timelineSelection.endSeconds - timelineSelection.startSeconds, DURATION_EPSILON);
    const padding = Math.max(span * 0.4, 2);
    let viewStart = timelineSelection.startSeconds - padding;
    let viewEnd = timelineSelection.endSeconds + padding;

    if (viewStart < 0) {
      viewEnd = Math.min(videoDurationSeconds, viewEnd - viewStart);
      viewStart = 0;
    }

    if (viewEnd > videoDurationSeconds) {
      const overflow = viewEnd - videoDurationSeconds;
      viewStart = Math.max(0, viewStart - overflow);
      viewEnd = videoDurationSeconds;
    }

    if (viewEnd - viewStart < 1) {
      viewEnd = Math.min(videoDurationSeconds, viewStart + 1);
      viewStart = Math.max(0, viewEnd - 1);
    }

    return {
      startSeconds: viewStart,
      endSeconds: viewEnd
    };
  }, [timelineSelection, videoDurationSeconds]);

  const timelineViewSpanSeconds = useMemo(
    () => Math.max(timelineView.endSeconds - timelineView.startSeconds, DURATION_EPSILON),
    [timelineView.endSeconds, timelineView.startSeconds]
  );

  const timelinePositionPercent = useMemo(() => {
    return clamp(
      ((timelineCursorSeconds - timelineView.startSeconds) / timelineViewSpanSeconds) * 100,
      0,
      100
    );
  }, [timelineCursorSeconds, timelineView.startSeconds, timelineViewSpanSeconds]);

  const selectionStartPercent = useMemo(() => {
    if (!timelineSelection) {
      return null;
    }

    return clamp(
      ((timelineSelection.startSeconds - timelineView.startSeconds) / timelineViewSpanSeconds) * 100,
      0,
      100
    );
  }, [timelineSelection, timelineView.startSeconds, timelineViewSpanSeconds]);

  const selectionEndPercent = useMemo(() => {
    if (!timelineSelection) {
      return null;
    }

    return clamp(
      ((timelineSelection.endSeconds - timelineView.startSeconds) / timelineViewSpanSeconds) * 100,
      0,
      100
    );
  }, [timelineSelection, timelineView.startSeconds, timelineViewSpanSeconds]);

  const persistHistory = useCallback((entries: SessionHistoryEntry[]) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    } catch {
      // Ignorar errores de almacenamiento.
    }
  }, []);

  const addHistoryEntry = useCallback(
    (
      mode: Exclude<ProcessingMode, 'idle'>,
      clips: OutputClip[],
      extra?: {
        multiCutsTemplate?: Array<{ startInput: string; endInput: string }>;
      }
    ) => {
      if (!selectedFile || clips.length === 0) {
        return;
      }

      const totalSizeBytes = clips.reduce((sum, clip) => sum + clip.sizeBytes, 0);

      const entry: SessionHistoryEntry = {
        id: createId(),
        createdAt: Date.now(),
        sourceFileName: selectedFile.name,
        mode,
        namePattern: outputNamePattern,
        outputCount: clips.length,
        totalSizeBytes,
        clips: clips.map((clip) => ({
          name: clip.name,
          sizeBytes: clip.sizeBytes,
          startSeconds: clip.startSeconds,
          durationSeconds: clip.durationSeconds,
          actualDurationSeconds: clip.actualDurationSeconds,
          verifiedPlayable: clip.verifiedPlayable
        })),
        multiCutsTemplate: extra?.multiCutsTemplate
      };

      setHistory((previous) => {
        const next = [entry, ...previous].slice(0, HISTORY_LIMIT);
        persistHistory(next);
        return next;
      });
    },
    [outputNamePattern, persistHistory, selectedFile]
  );

  const clearRunState = useCallback(() => {
    setError(null);
    setStatus('');
    setProgress(0);
    setLogs([]);
    setEtaSeconds(null);
    setCurrentClipElapsedSeconds(null);
  }, []);

  const setMarkerValue = useCallback(
    (target: MarkerTarget, secondsValue: number) => {
      const durationCap = videoDurationSeconds ?? Number.POSITIVE_INFINITY;
      const nextSeconds = clamp(secondsValue, 0, durationCap);

      if (target === 'single-start') {
        const currentDuration = parseTimeToSeconds(durationInput) ?? 0;
        const maxStart = Math.max(durationCap - Math.max(currentDuration, DURATION_EPSILON), 0);
        const safeStart = clamp(nextSeconds, 0, maxStart);
        setStartInput(formatSecondsToTime(safeStart, true));
        return;
      }

      if (target === 'single-end') {
        const currentStart = parseTimeToSeconds(startInput) ?? 0;
        const minEnd = currentStart + DURATION_EPSILON;
        const safeEnd = clamp(nextSeconds, minEnd, durationCap);
        setDurationInput(formatSecondsToTime(safeEnd - currentStart, true));
        return;
      }

      if (!activeMultiCutId) {
        return;
      }

      setMultiCuts((previous) =>
        previous.map((item) => {
          if (item.id !== activeMultiCutId) {
            return item;
          }

          if (target === 'multi-start') {
            const parsedEnd = parseTimeToSeconds(item.endInput);
            const maxStart =
              parsedEnd === null
                ? durationCap
                : clamp(parsedEnd - DURATION_EPSILON, 0, durationCap);
            const safeStart = clamp(nextSeconds, 0, maxStart);
            return { ...item, startInput: formatSecondsToTime(safeStart, true) };
          }

          const parsedStart = parseTimeToSeconds(item.startInput) ?? 0;
          const minEnd = parsedStart + DURATION_EPSILON;
          const safeEnd = clamp(nextSeconds, minEnd, durationCap);
          return { ...item, endInput: formatSecondsToTime(safeEnd, true) };
        })
      );
    },
    [activeMultiCutId, durationInput, startInput, videoDurationSeconds]
  );

  const getMarkerValue = useCallback((): number | null => {
    if (markerTarget === 'single-start') {
      return parseTimeToSeconds(startInput);
    }

    if (markerTarget === 'single-end') {
      const startSeconds = parseTimeToSeconds(startInput);
      const durationSeconds = parseTimeToSeconds(durationInput);

      if (startSeconds === null || durationSeconds === null) {
        return null;
      }

      return startSeconds + durationSeconds;
    }

    if (!activeMultiCutId) {
      return null;
    }

    const targetCut = multiCuts.find((item) => item.id === activeMultiCutId);

    if (!targetCut) {
      return null;
    }

    return markerTarget === 'multi-start'
      ? parseTimeToSeconds(targetCut.startInput)
      : parseTimeToSeconds(targetCut.endInput);
  }, [activeMultiCutId, durationInput, markerTarget, multiCuts, startInput]);

  const seekPreview = useCallback((seconds: number) => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const durationCap = Number.isFinite(video.duration) ? video.duration : videoDurationSeconds ?? Number.POSITIVE_INFINITY;
    const nextTime = clamp(seconds, 0, durationCap);
    video.currentTime = nextTime;
    setTimelineCursorSeconds(nextTime);
  }, [videoDurationSeconds]);

  const updateEtaFromProgress = useCallback((mode: ProcessingMode, progressValue: number) => {
    const now = Date.now();
    const clipElapsed = timingRef.current.clipStartedAt > 0 ? (now - timingRef.current.clipStartedAt) / 1000 : 0;
    setCurrentClipElapsedSeconds(clipElapsed);

    if (isSingleClipMode(mode)) {
      if (progressValue > 0.01) {
        const remaining = clipElapsed * ((1 - progressValue) / progressValue);
        setEtaSeconds(Math.max(remaining, 0));
      }

      return;
    }

    const context = progressContextRef.current;
    const completed = timingRef.current.completedClipSeconds;
    const averageCompleted =
      completed.length > 0
        ? completed.reduce((sum, value) => sum + value, 0) / completed.length
        : progressValue > 0.01
          ? clipElapsed / progressValue
          : null;

    if (averageCompleted === null) {
      setEtaSeconds(null);
      return;
    }

    const remainingCurrent = progressValue > 0.01 ? clipElapsed * ((1 - progressValue) / progressValue) : averageCompleted;
    const remainingJobs = Math.max(context.totalClips - context.clipIndex - 1, 0);
    const estimate = remainingCurrent + averageCompleted * remainingJobs;
    setEtaSeconds(Math.max(estimate, 0));
  }, []);

  const createProcessor = useCallback(() => {
    return new BrowserFFmpeg({
      onLog: (event) => {
        appendLogLine(`[ffmpeg:${event.type}] ${event.message}`);
      },
      onProgress: (event) => {
        const context = progressContextRef.current;

        if (context.mode === 'idle') {
          return;
        }

        const normalizedProgress = clamp(event.progress, 0, 1);

        if (isSingleClipMode(context.mode)) {
          setProgress(normalizedProgress * 100);
          updateEtaFromProgress(context.mode, normalizedProgress);
          return;
        }

        const aggregated = ((context.clipIndex + normalizedProgress) / Math.max(context.totalClips, 1)) * 100;
        setProgress(clamp(aggregated, 0, 100));
        updateEtaFromProgress(context.mode, normalizedProgress);
      }
    });
  }, [appendLogLine, updateEtaFromProgress]);

  const resetProcessor = useCallback(() => {
    ffmpegRef.current?.terminate();
    ffmpegRef.current = createProcessor();
    setIsCoreLoaded(false);
    setIsCoreLoading(false);
    coreLoadPromiseRef.current = null;
  }, [createProcessor]);

  const verifyOutputBlob = useCallback(async (blob: Blob): Promise<VerificationResult> => {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      let settled = false;
      let durationSeconds: number | null = null;

      const cleanup = () => {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(objectUrl);
      };

      const finish = (result: VerificationResult) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(result);
      };

      const timeoutId = window.setTimeout(() => {
        finish({
          playable: false,
          durationSeconds,
          errorMessage: 'Tiempo de verificación agotado.'
        });
      }, 12_000);

      video.preload = 'auto';
      video.muted = true;

      video.onloadedmetadata = () => {
        if (Number.isFinite(video.duration)) {
          durationSeconds = video.duration;
        }
      };

      video.oncanplay = () => {
        finish({
          playable: true,
          durationSeconds
        });
      };

      video.onerror = () => {
        finish({
          playable: false,
          durationSeconds,
          errorMessage: 'No se pudo reproducir el clip generado.'
        });
      };

      video.src = objectUrl;
      video.load();
    });
  }, []);

  const ensureCoreReady = useCallback(async (): Promise<boolean> => {
    if (isCoreLoaded) {
      return true;
    }

    if (coreLoadPromiseRef.current) {
      return coreLoadPromiseRef.current;
    }

    const processor = ffmpegRef.current;

    if (!processor) {
      setError('No se pudo inicializar ffmpeg.');
      return false;
    }

    const loadPromise = (async () => {
      setIsCoreLoading(true);
      setError(null);
      setStatus('Iniciando motor ffmpeg.wasm...');

      try {
        await processor.load();
        setIsCoreLoaded(true);
        setStatus('Motor ffmpeg listo.');
        appendLogLine('[ui] Motor ffmpeg inicializado automáticamente.');
        return true;
      } catch (loadError) {
        const message = toErrorMessage(loadError);
        setError(message);
        setStatus('Error al cargar ffmpeg.wasm.');
        appendLogLine(`[ui] Falló la carga automática del motor: ${message}`);
        return false;
      } finally {
        setIsCoreLoading(false);
        coreLoadPromiseRef.current = null;
      }
    })();

    coreLoadPromiseRef.current = loadPromise;
    return loadPromise;
  }, [appendLogLine, isCoreLoaded]);

  useEffect(() => {
    ffmpegRef.current = createProcessor();

    try {
      setHistory(parseStoredHistory(localStorage.getItem(HISTORY_KEY)));
    } catch {
      setHistory([]);
    }

    return () => {
      ffmpegRef.current?.terminate();
    };
  }, [createProcessor]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }

      outputsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
      imageOutputsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  useEffect(() => {
    if (multiCuts.length === 0) {
      setActiveMultiCutId(null);
      return;
    }

    if (activeMultiCutId === null || !multiCuts.some((item) => item.id === activeMultiCutId)) {
      setActiveMultiCutId(multiCuts[0].id);
    }
  }, [activeMultiCutId, multiCuts]);

  useEffect(() => {
    if (activeModeTab === 'simple') {
      setMarkerTarget('single-start');
      return;
    }

    if (activeModeTab === 'multi' && activeMultiCutId !== null) {
      setMarkerTarget('multi-start');
    }
  }, [activeModeTab, activeMultiCutId]);

  useEffect(() => {
    const player = videoRef.current;

    if (!player) {
      return;
    }

    const handleTimeUpdate = () => {
      if (Number.isFinite(player.currentTime)) {
        setTimelineCursorSeconds(player.currentTime);
      }

      if (rangeLoop && player.currentTime >= rangeLoop.end - DURATION_EPSILON) {
        player.currentTime = rangeLoop.start;
        void player.play().catch(() => {
          // Ignorar errores de autoplay.
        });
      }
    };

    player.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      player.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [rangeLoop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;

      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }

      const player = videoRef.current;

      if (!player) {
        return;
      }

      const current = Number.isFinite(player.currentTime) ? player.currentTime : timelineCursorSeconds;

      if (event.key.toLowerCase() === 'i') {
        event.preventDefault();

        if (activeModeTab === 'multi' && activeMultiCutId !== null) {
          setMarkerTarget('multi-start');
          setMarkerValue('multi-start', current);
          appendLogLine(`[ui] Atajo I: inicio de corte activo en ${formatSecondsToTime(current, true)}.`);
          return;
        }

        setMarkerTarget('single-start');
        setMarkerValue('single-start', current);
        appendLogLine(`[ui] Atajo I: start del recorte simple en ${formatSecondsToTime(current, true)}.`);
        return;
      }

      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();

        if (activeModeTab === 'multi' && activeMultiCutId !== null) {
          setMarkerTarget('multi-end');
          setMarkerValue('multi-end', current);
          appendLogLine(`[ui] Atajo O: fin de corte activo en ${formatSecondsToTime(current, true)}.`);
          return;
        }

        const startSeconds = parseTimeToSeconds(startInput);

        if (startSeconds !== null && current > startSeconds + DURATION_EPSILON) {
          setMarkerTarget('single-end');
          setMarkerValue('single-end', current);
          appendLogLine(`[ui] Atajo O: fin del recorte simple en ${formatSecondsToTime(current, true)}.`);
          return;
        }

        if (markerTarget !== 'single-start') {
          setMarkerTarget('single-start');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    activeModeTab,
    activeMultiCutId,
    appendLogLine,
    markerTarget,
    setMarkerValue,
    startInput,
    timelineCursorSeconds
  ]);

  const handleIncomingFile = useCallback(
    (file: File) => {
      if (!isVideoFile(file)) {
        setError('Selecciona un archivo de video válido (preferentemente MP4).');
        return;
      }

      clearRunState();
      setWarning(null);
      replaceOutputs([]);

      const nextCuts = createMultiCutInputs();

      setSelectedFile(file);
      setVideoDurationSeconds(null);

      setStartInput('00:00:00');
      setDurationInput('00:00:34');
      setAutoStartInput('');
      setClipLengthInput('00:00:34');
      setInstagramOutputName(buildInstagramOutputName(file.name));
      setMultiCuts(nextCuts);
      setActiveMultiCutId(nextCuts[0]?.id ?? null);
      setTimelineCursorSeconds(0);
      setRangeLoop(null);

      setWarning(
        file.size >= LARGE_FILE_THRESHOLD
          ? 'Archivo grande detectado. El procesamiento en el navegador puede tardar bastante y consumir mucha memoria.'
          : null
      );

      const objectUrl = URL.createObjectURL(file);
      setPreviewSource(objectUrl);

      void ensureCoreReady();
    },
    [clearRunState, ensureCoreReady, replaceOutputs, setPreviewSource]
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file) {
      handleIncomingFile(file);
    }

    event.target.value = '';
  };

  const handleImageBatchInput = (event: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(event.target.files ?? []);
    const accepted = incoming.filter((file) => isSupportedImageFile(file));
    const ignored = incoming.length - accepted.length;

    if (accepted.length === 0) {
      if (incoming.length > 0) {
        setError('No hay imágenes válidas. Formatos soportados: JPG, JPEG, PNG, WEBP.');
      }
      event.target.value = '';
      return;
    }

    setError(null);
    setImageBatchFiles(accepted);
    replaceImageOutputs([]);
    setWarning(ignored > 0 ? `Se omitieron ${ignored} archivo(s) no compatibles.` : null);
    void ensureCoreReady();

    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      handleIncomingFile(file);
    }
  };

  const getTimelineSecondsFromClientX = useCallback(
    (clientX: number): number | null => {
      if (!timelineRef.current) {
        return null;
      }

      const rect = timelineRef.current.getBoundingClientRect();

      if (rect.width <= 0) {
        return null;
      }

      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return timelineView.startSeconds + ratio * timelineViewSpanSeconds;
    },
    [timelineView.startSeconds, timelineViewSpanSeconds]
  );

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const targetElement = event.target as HTMLElement;

      if (targetElement.dataset.role === 'timeline-handle') {
        return;
      }

      const targetSeconds = getTimelineSecondsFromClientX(event.clientX);

      if (targetSeconds === null) {
        return;
      }

      seekPreview(targetSeconds);
    },
    [getTimelineSecondsFromClientX, seekPreview]
  );

  const handleTimelineHandlePointerDown = useCallback(
    (target: MarkerTarget) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (isProcessing) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      setMarkerTarget(target);
      setActiveDragTarget(target);

      const targetSeconds = getTimelineSecondsFromClientX(event.clientX);

      if (targetSeconds !== null) {
        setMarkerValue(target, targetSeconds);
        seekPreview(targetSeconds);
      }
    },
    [getTimelineSecondsFromClientX, isProcessing, seekPreview, setMarkerValue]
  );

  useEffect(() => {
    if (!activeDragTarget) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const targetSeconds = getTimelineSecondsFromClientX(event.clientX);

      if (targetSeconds === null) {
        return;
      }

      setMarkerValue(activeDragTarget, targetSeconds);
      seekPreview(targetSeconds);
    };

    const onPointerUp = () => {
      const markerValue = getMarkerValue();

      if (markerValue !== null) {
        appendLogLine(`[ui] ${markerTargetLabel(activeDragTarget)}: ${formatSecondsToTime(markerValue, true)}.`);
      }

      setActiveDragTarget(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [activeDragTarget, appendLogLine, getMarkerValue, getTimelineSecondsFromClientX, seekPreview, setMarkerValue]);

  const updateMultiCutField = (id: number, field: 'startInput' | 'endInput', value: string) => {
    setMultiCuts((previous) => {
      const targetIndex = previous.findIndex((item) => item.id === id);

      if (targetIndex < 0) {
        return previous;
      }

      const next = [...previous];
      const oldTarget = previous[targetIndex];
      next[targetIndex] = { ...oldTarget, [field]: value };

      if (field === 'endInput' && targetIndex + 1 < next.length) {
        const nextCut = next[targetIndex + 1];
        const oldEndTrimmed = oldTarget.endInput.trim();
        const nextStartTrimmed = nextCut.startInput.trim();
        const shouldSyncNextStart = nextStartTrimmed === '' || nextStartTrimmed === oldEndTrimmed;

        if (shouldSyncNextStart) {
          next[targetIndex + 1] = { ...nextCut, startInput: value.trim() };
        }
      }

      return next;
    });
  };

  const addMultiCutRow = () => {
    const lastCut = multiCuts[multiCuts.length - 1];
    let nextStartInput = '';

    if (lastCut) {
      const parsedLastEnd = parseTimeToSeconds(lastCut.endInput);

      if (parsedLastEnd !== null) {
        nextStartInput = formatSecondsToTime(parsedLastEnd, true);
      } else if (videoDurationSeconds !== null) {
        nextStartInput = formatSecondsToTime(videoDurationSeconds, true);
      }
    }

    const newCut: MultiCutInput = {
      id: Date.now() + Math.round(Math.random() * 10_000),
      startInput: nextStartInput,
      endInput: ''
    };

    setMultiCuts((previous) => [...previous, newCut]);
    setActiveMultiCutId(newCut.id);
  };

  const removeMultiCutRow = (id: number) => {
    setMultiCuts((previous) => (previous.length <= 1 ? previous : previous.filter((item) => item.id !== id)));
  };

  const handleCutDragStart = (id: number) => {
    setDraggingCutId(id);
  };

  const handleCutDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleCutDrop = (targetId: number) => {
    if (draggingCutId === null || draggingCutId === targetId) {
      setDraggingCutId(null);
      return;
    }

    setMultiCuts((previous) => {
      const sourceIndex = previous.findIndex((item) => item.id === draggingCutId);
      const targetIndex = previous.findIndex((item) => item.id === targetId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return previous;
      }

      const copy = [...previous];
      const [moved] = copy.splice(sourceIndex, 1);
      copy.splice(targetIndex, 0, moved);
      return copy;
    });

    setDraggingCutId(null);
  };

  const previewMultiRange = async (cut: MultiCutInput) => {
    const startSeconds = parseTimeToSeconds(cut.startInput);
    const endSeconds = parseTimeToSeconds(cut.endInput);

    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds + DURATION_EPSILON) {
      const message = 'No se puede previsualizar: define inicio y fin válidos (fin > inicio).';
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return;
    }

    if (videoDurationSeconds !== null && startSeconds >= videoDurationSeconds) {
      const message = 'No se puede previsualizar: inicio fuera de la duración del video.';
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return;
    }

    const effectiveEnd = videoDurationSeconds !== null ? Math.min(endSeconds, videoDurationSeconds) : endSeconds;

    setError(null);
    setActiveMultiCutId(cut.id);
    setRangeLoop({
      start: startSeconds,
      end: effectiveEnd,
      cutId: cut.id
    });

    seekPreview(startSeconds);

    try {
      await videoRef.current?.play();
      appendLogLine(
        `[ui] Previsualización en loop: ${formatSecondsToTime(startSeconds)} - ${formatSecondsToTime(effectiveEnd)}.`
      );
    } catch (playError) {
      setError(`No se pudo iniciar la reproducción: ${toErrorMessage(playError)}`);
    }
  };

  const stopRangeLoopPreview = () => {
    setRangeLoop(null);
    appendLogLine('[ui] Previsualización en loop detenida.');
  };

  const validateSingleCut = (): JobValidation | null => {
    const fail = (message: string): null => {
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    };

    if (!selectedFile) {
      return fail('Carga un video primero.');
    }

    const startRaw = startInput.trim();
    const durationRaw = durationInput.trim();
    const startSeconds = startRaw ? parseTimeToSeconds(startRaw) : 0;
    let durationSecondsRaw = durationRaw ? parseTimeToSeconds(durationRaw) : null;

    if (startSeconds === null) {
      return fail('Start time inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales.');
    }

    if (startSeconds < 0) {
      return fail('Start time debe ser mayor o igual que 0.');
    }

    const notices: string[] = [];

    if (!startRaw) {
      notices.push('Start vacío: se usa 00:00:00.');
    }

    if (!durationRaw) {
      if (videoDurationSeconds === null) {
        return fail('Duration vacía: se requiere metadata del video para usar el final como límite.');
      }

      durationSecondsRaw = Math.max(videoDurationSeconds - startSeconds, 0);
      notices.push('Duration vacía: se usa hasta el final del video.');
    }

    if (durationSecondsRaw === null) {
      return fail('Duration inválida. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales.');
    }

    if (durationSecondsRaw <= 0) {
      return fail('Duration debe ser mayor que 0.');
    }

    let durationSeconds = durationSecondsRaw;

    if (videoDurationSeconds !== null) {
      if (startSeconds >= videoDurationSeconds) {
        return fail('Start time está fuera de la duración del video.');
      }

      const remaining = videoDurationSeconds - startSeconds;

      if (remaining <= DURATION_EPSILON) {
        return fail('No hay contenido disponible desde ese Start time.');
      }

      if (durationSeconds > remaining + DURATION_EPSILON) {
        durationSeconds = remaining;
        notices.push(`Duration ajustada automáticamente a ${formatSecondsToTime(durationSeconds)}.`);
      }
    }

    return {
      notices,
      jobs: [
        {
          outputName: buildOutputName(outputNamePattern, selectedFile.name, 0, startSeconds, durationSeconds),
          startSeconds,
          durationSeconds,
          label: 'Recorte simple'
        }
      ]
    };
  };

  const validateAutoSplit = (): JobValidation | null => {
    const fail = (message: string): null => {
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    };

    if (!selectedFile) {
      return fail('Carga un video primero.');
    }

    if (videoDurationSeconds === null) {
      return fail('No se pudo leer la duración del video. Reproduce o recarga el archivo para obtener metadata.');
    }

    const startSeconds = autoStartInput.trim() ? parseTimeToSeconds(autoStartInput) : 0;
    const clipLengthSeconds = parseTimeToSeconds(clipLengthInput);

    if (startSeconds === null) {
      return fail('Auto Start inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales.');
    }

    if (clipLengthSeconds === null) {
      return fail('Clip length inválido. Usa HH:MM:SS(.mmm), MM:SS(.mmm) o segundos con decimales.');
    }

    if (startSeconds < 0) {
      return fail('Auto Start debe ser mayor o igual que 0.');
    }

    if (clipLengthSeconds <= 0) {
      return fail('Clip length debe ser mayor que 0.');
    }

    if (startSeconds >= videoDurationSeconds) {
      return fail('Auto Start está fuera de la duración del video.');
    }

    const jobs: ClipJob[] = [];

    for (let cursor = startSeconds, index = 0; cursor < videoDurationSeconds - DURATION_EPSILON; index += 1) {
      const remaining = videoDurationSeconds - cursor;
      const durationSeconds = Math.min(clipLengthSeconds, remaining);

      jobs.push({
        outputName: buildOutputName(outputNamePattern, selectedFile.name, index, cursor, durationSeconds),
        startSeconds: cursor,
        durationSeconds,
        label: `Auto clip ${index + 1}`
      });

      cursor += clipLengthSeconds;
    }

    if (jobs.length === 0) {
      return fail('No hay clips para generar con esos parámetros.');
    }

    return { jobs, notices: [] };
  };

  const validateMultiCut = (): JobValidation | null => {
    const fail = (message: string): null => {
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    };

    if (!selectedFile) {
      return fail('Carga un video primero.');
    }

    if (multiCuts.length === 0) {
      return fail('Agrega al menos un corte.');
    }

    const jobs: ClipJob[] = [];
    const notices: string[] = [];
    let previousEndSeconds = 0;

    for (let index = 0; index < multiCuts.length; index += 1) {
      const cut = multiCuts[index];
      const startRaw = cut.startInput.trim();
      const endRaw = cut.endInput.trim();

      if (!startRaw && !endRaw) {
        notices.push(`Corte ${index + 1}: fila vacía, se omite.`);
        continue;
      }

      let startSeconds = startRaw ? parseTimeToSeconds(startRaw) : previousEndSeconds;
      let endSecondsRaw = endRaw ? parseTimeToSeconds(endRaw) : null;

      if (startSeconds === null) {
        return fail(`Corte ${index + 1}: inicio inválido.`);
      }

      if (!startRaw) {
        const fallbackStart = index === 0 ? '00:00:00' : formatSecondsToTime(previousEndSeconds, true);
        notices.push(`Corte ${index + 1}: inicio vacío, se usa ${fallbackStart}.`);
      }

      if (!endRaw) {
        if (videoDurationSeconds === null) {
          return fail(`Corte ${index + 1}: fin vacío y no hay metadata para usar el final del video.`);
        }

        endSecondsRaw = videoDurationSeconds;
        notices.push(`Corte ${index + 1}: fin vacío, se usa ${formatSecondsToTime(videoDurationSeconds)}.`);
      }

      if (endSecondsRaw === null) {
        return fail(`Corte ${index + 1}: fin inválido.`);
      }

      if (startSeconds < 0) {
        return fail(`Corte ${index + 1}: el inicio debe ser mayor o igual que 0.`);
      }

      let effectiveEnd = endSecondsRaw;

      if (videoDurationSeconds !== null) {
        if (startSeconds >= videoDurationSeconds) {
          if (!endRaw && startSeconds <= videoDurationSeconds + DURATION_EPSILON) {
            notices.push(`Corte ${index + 1}: inicia en el final del video, se omite.`);
            continue;
          }

          return fail(`Corte ${index + 1}: el inicio está fuera de la duración del video.`);
        }

        if (effectiveEnd > videoDurationSeconds + DURATION_EPSILON) {
          effectiveEnd = videoDurationSeconds;
          notices.push(
            `Corte ${index + 1}: fin ajustado a ${formatSecondsToTime(videoDurationSeconds)} para no exceder el video.`
          );
        }
      }

      if (effectiveEnd <= startSeconds + DURATION_EPSILON) {
        if (!endRaw) {
          notices.push(`Corte ${index + 1}: sin duración efectiva, se omite.`);
          continue;
        }

        return fail(`Corte ${index + 1}: el fin debe ser mayor que el inicio.`);
      }

      const durationSeconds = effectiveEnd - startSeconds;

      jobs.push({
        outputName: buildOutputName(outputNamePattern, selectedFile.name, index, startSeconds, durationSeconds),
        startSeconds,
        durationSeconds,
        label: `Corte ${index + 1}`
      });

      previousEndSeconds = effectiveEnd;
    }

    if (jobs.length === 0) {
      return fail('No hay cortes válidos para procesar.');
    }

    return { jobs, notices };
  };

  const validateInstagramFormat = (): JobValidation | null => {
    const fail = (message: string): null => {
      setError(message);
      appendLogLine(`[ui] ${message}`);
      return null;
    };

    if (!selectedFile) {
      return fail('Carga un video primero.');
    }

    const fallbackName = buildInstagramOutputName(selectedFile.name);
    const outputName = normalizeVideoOutputName(instagramOutputName, fallbackName);
    const notices: string[] = [];

    if (videoDurationSeconds === null || videoDurationSeconds <= 0) {
      notices.push('No hay metadata de duración; se procesará el archivo completo.');
    }

    return {
      notices,
      jobs: [
        {
          outputName,
          startSeconds: 0,
          durationSeconds: videoDurationSeconds ?? 0,
          label: 'Instagram 4:5',
          videoFilter: INSTAGRAM_4X5_FILTER
        }
      ]
    };
  };

  const waitForQueueGate = useCallback(async () => {
    while (queueControlRef.current.paused && !queueControlRef.current.cancelled) {
      await delay(120);
    }

    if (queueControlRef.current.cancelled) {
      throw new Error('Procesamiento cancelado por el usuario.');
    }
  }, []);

  const processJobs = useCallback(
    async (
      mode: Exclude<ProcessingMode, 'idle'>,
      validation: JobValidation,
      options?: {
        multiCutsTemplate?: Array<{ startInput: string; endInput: string }>;
      }
    ): Promise<void> => {
      const processor = ffmpegRef.current;

      if (!processor || !selectedFile) {
        setError('No se pudo iniciar ffmpeg.');
        return;
      }

      clearRunState();
      replaceOutputs([]);
      setIsProcessing(true);
      setCurrentMode(mode);

      queueControlRef.current = { paused: false, cancelled: false };
      setQueuePaused(false);
      setQueueCancelRequested(false);

      const jobs = validation.jobs;

      if (validation.notices.length > 0) {
        setWarning(validation.notices.join(' '));
        validation.notices.forEach((notice) => appendLogLine(`[ui] ${notice}`));
      }

      progressContextRef.current = {
        mode,
        clipIndex: 0,
        totalClips: jobs.length
      };

      setCurrentClipNumber(1);
      setCurrentClipTotal(jobs.length);

      timingRef.current = {
        runStartedAt: Date.now(),
        clipStartedAt: 0,
        completedClipSeconds: []
      };

      let inputPath: string | null = null;
      const generated: OutputClip[] = [];

      try {
        const loaded = await ensureCoreReady();

        if (!loaded) {
          return;
        }

        inputPath = await processor.writeInputFile(selectedFile);

        for (let index = 0; index < jobs.length; index += 1) {
          await waitForQueueGate();

          const job = jobs[index];
          progressContextRef.current.clipIndex = index;

          setCurrentClipNumber(index + 1);
          setCurrentClipTotal(jobs.length);
          setStatus(`Recodificando ${job.label} (${index + 1}/${jobs.length})...`);

          const endLabel =
            job.durationSeconds > 0
              ? formatSecondsToTime(job.startSeconds + job.durationSeconds, true)
              : 'fin del archivo';

          appendLogLine(
            `[ui] ${job.label}: start=${formatSecondsToTime(job.startSeconds, true)} end=${endLabel} salida=${job.outputName}`
          );

          timingRef.current.clipStartedAt = Date.now();

          const outputBytes = await processor.transcodeClip({
            inputPath,
            outputPath: job.outputName,
            startSeconds: job.startSeconds,
            durationSeconds: job.durationSeconds,
            videoFilter: job.videoFilter
          });

          const clipElapsed = (Date.now() - timingRef.current.clipStartedAt) / 1000;
          timingRef.current.completedClipSeconds.push(clipElapsed);

          const outputBlob = new Blob([toArrayBuffer(outputBytes)], { type: 'video/mp4' });
          const verification = await verifyOutputBlob(outputBlob);
          const outputUrl = URL.createObjectURL(outputBlob);

          const clip: OutputClip = {
            id: createId(),
            name: job.outputName,
            url: outputUrl,
            blob: outputBlob,
            sizeBytes: outputBytes.byteLength,
            startSeconds: job.startSeconds,
            durationSeconds:
              job.durationSeconds > 0 ? job.durationSeconds : Math.max(verification.durationSeconds ?? 0, DURATION_EPSILON),
            actualDurationSeconds: verification.durationSeconds,
            verifiedPlayable: verification.playable,
            verificationError: verification.errorMessage
          };

          if (!verification.playable) {
            appendLogLine(`[ui] Verificación fallida en ${job.outputName}: ${verification.errorMessage ?? 'error desconocido'}.`);
          }

          generated.push(clip);
          appendOutput(clip);
        }

        setProgress(100);
        setEtaSeconds(0);
        setStatus(`Proceso ${mode} completado. ${jobs.length} clip(s) generado(s).`);

        addHistoryEntry(mode, generated, {
          multiCutsTemplate: options?.multiCutsTemplate
        });
      } catch (processingError) {
        const message = toErrorMessage(processingError);
        const partial = outputsRef.current.length;
        const partialMessage = partial > 0 ? ` Se generaron ${partial} clips antes del error.` : '';

        setError(`${message}${partialMessage}`);
        setStatus('Proceso interrumpido.');
      } finally {
        if (inputPath) {
          await processor.deleteFile(inputPath);
        }

        progressContextRef.current.mode = 'idle';
        setCurrentMode('idle');
        setCurrentClipNumber(0);
        setCurrentClipTotal(0);
        setIsProcessing(false);
        queueControlRef.current = { paused: false, cancelled: false };
        setQueuePaused(false);
        setQueueCancelRequested(false);
      }
    },
    [
      addHistoryEntry,
      appendLogLine,
      appendOutput,
      clearRunState,
      ensureCoreReady,
      replaceOutputs,
      selectedFile,
      verifyOutputBlob,
      waitForQueueGate
    ]
  );

  const handleTrim = async () => {
    const validation = validateSingleCut();

    if (!validation) {
      return;
    }

    await processJobs('single', validation);
  };

  const handleAutoSplit = async () => {
    const validation = validateAutoSplit();

    if (!validation) {
      return;
    }

    await processJobs('auto', validation);
  };

  const handleMultiCut = async () => {
    const validation = validateMultiCut();

    if (!validation) {
      return;
    }

    await processJobs('multi', validation, {
      multiCutsTemplate: multiCuts.map((cut) => ({
        startInput: cut.startInput,
        endInput: cut.endInput
      }))
    });
  };

  const handleInstagramFormat = async () => {
    const validation = validateInstagramFormat();

    if (!validation) {
      return;
    }

    await processJobs('instagram', validation);
  };

  const handleConvertImageBatch = async () => {
    if (imageBatchFiles.length === 0) {
      setError('Selecciona al menos una imagen para procesar.');
      return;
    }

    clearRunState();
    const compatibilityNotice = 'Modo compatibilidad (canvas) activo para conversion de imagenes.';
    setWarning(compatibilityNotice);
    replaceImageOutputs([]);
    setIsProcessing(true);
    setCurrentMode('images');

    queueControlRef.current = { paused: false, cancelled: false };
    setQueuePaused(false);
    setQueueCancelRequested(false);

    const total = imageBatchFiles.length;
    progressContextRef.current = {
      mode: 'images',
      clipIndex: 0,
      totalClips: total
    };
    setCurrentClipNumber(1);
    setCurrentClipTotal(total);

    timingRef.current = {
      runStartedAt: Date.now(),
      clipStartedAt: 0,
      completedClipSeconds: []
    };

    const generated: OutputImage[] = [];
    const duplicateNames = new Map<string, number>();
    let failedCount = 0;
    let firstFailureMessage: string | null = null;

    try {
      appendLogLine('[ui] Lote de imagenes: usando conversion por canvas (1080x1350, crop centrado).');

      for (let index = 0; index < total; index += 1) {
        await waitForQueueGate();

        const sourceFile = imageBatchFiles[index];
        progressContextRef.current.clipIndex = index;
        setCurrentClipNumber(index + 1);
        setCurrentClipTotal(total);
        setProgress((index / total) * 100);
        setStatus(`Convirtiendo imagen ${index + 1}/${total}...`);

        const baseKey = sanitizeFileName(baseNameFromFile(sourceFile.name)).toLowerCase();
        const duplicateIndex = duplicateNames.get(baseKey) ?? 0;
        duplicateNames.set(baseKey, duplicateIndex + 1);
        const outputName = buildImageBatchOutputName(sourceFile.name, duplicateIndex);

        appendLogLine(`[ui] Imagen ${index + 1}: ${sourceFile.name} -> ${outputName}`);
        timingRef.current.clipStartedAt = Date.now();

        try {
          const outputBytes = await convertImageToInstagramJpegBytes(sourceFile);

          const clipElapsed = (Date.now() - timingRef.current.clipStartedAt) / 1000;
          timingRef.current.completedClipSeconds.push(clipElapsed);

          const outputBlob = new Blob([toArrayBuffer(outputBytes)], { type: 'image/jpeg' });
          const outputUrl = URL.createObjectURL(outputBlob);
          const output: OutputImage = {
            id: createId(),
            name: outputName,
            sourceName: sourceFile.name,
            url: outputUrl,
            blob: outputBlob,
            sizeBytes: outputBytes.byteLength
          };

          generated.push(output);
          appendImageOutput(output);
        } catch (itemError) {
          failedCount += 1;
          const itemMessage = toErrorMessage(itemError);
          firstFailureMessage ??= itemMessage;
          appendLogLine(`[ui] Error en ${sourceFile.name}: ${itemMessage}`);
        } finally {
          setProgress(((index + 1) / total) * 100);
        }
      }

      if (generated.length === 0) {
        throw new Error(firstFailureMessage ?? 'No se pudo generar ninguna imagen del lote.');
      }

      setEtaSeconds(0);
      if (failedCount > 0) {
        const summary = `Se generaron ${generated.length} imágenes y fallaron ${failedCount}.`;
        setWarning(`${compatibilityNotice} ${summary}`);
      } else {
        setWarning(compatibilityNotice);
      }
      setStatus(
        failedCount > 0
          ? `Lote completado con errores. Generadas: ${generated.length}. Fallidas: ${failedCount}.`
          : `Lote completado. ${generated.length} imagen(es) generada(s).`
      );
    } catch (processingError) {
      const message = toErrorMessage(processingError);
      const partial = generated.length;
      const partialMessage = partial > 0 ? ` Se generaron ${partial} imágenes antes del error.` : '';
      setError(`${message}${partialMessage}`);
      setStatus('Proceso de imágenes interrumpido.');
    } finally {
      progressContextRef.current.mode = 'idle';
      setCurrentMode('idle');
      setCurrentClipNumber(0);
      setCurrentClipTotal(0);
      setIsProcessing(false);
      queueControlRef.current = { paused: false, cancelled: false };
      setQueuePaused(false);
      setQueueCancelRequested(false);
    }
  };

  const handlePauseQueue = () => {
    if (!isProcessing) {
      return;
    }

    queueControlRef.current.paused = true;
    setQueuePaused(true);
    setStatus('Cola en pausa.');
    appendLogLine('[ui] Cola pausada por el usuario.');
  };

  const handleResumeQueue = () => {
    if (!isProcessing) {
      return;
    }

    queueControlRef.current.paused = false;
    setQueuePaused(false);
    setStatus('Cola reanudada.');
    appendLogLine('[ui] Cola reanudada por el usuario.');
  };

  const handleCancelQueue = () => {
    if (!isProcessing) {
      return;
    }

    queueControlRef.current.cancelled = true;
    queueControlRef.current.paused = false;
    setQueuePaused(false);
    setQueueCancelRequested(true);
    setStatus('Cancelando procesamiento...');
    appendLogLine('[ui] Cancelación solicitada por el usuario.');

    resetProcessor();
  };

  const handleDownloadAll = async () => {
    if (downloadableOutputs.length === 0) {
      setError('No hay clips verificados para descargar en bloque.');
      return;
    }

    setError(null);
    setIsProcessing(true);
    setProgress(0);
    setStatus('Empaquetando clips para descarga...');

    try {
      const zip = new JSZip();

      downloadableOutputs.forEach((clip) => {
        zip.file(clip.name, clip.blob);
      });

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        },
        (metadata) => {
          setProgress(clamp(metadata.percent, 0, 100));
        }
      );

      const downloadUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${sanitizeFileName(baseNameFromFile(selectedFile?.name ?? 'clips'))}_clips.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      setProgress(100);
      setStatus('ZIP generado. Descarga iniciada.');
      appendLogLine(`[ui] ZIP generado con ${downloadableOutputs.length} clips verificados.`);
    } catch (zipError) {
      setError(`No se pudo empaquetar los clips: ${toErrorMessage(zipError)}`);
      setStatus('Error al generar ZIP.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadAllImages = async () => {
    if (imageOutputs.length === 0) {
      setError('No hay imágenes generadas para descargar.');
      return;
    }

    setError(null);
    setIsProcessing(true);
    setProgress(0);
    setStatus('Empaquetando imágenes para descarga...');

    try {
      const zip = new JSZip();

      imageOutputs.forEach((image) => {
        zip.file(image.name, image.blob);
      });

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        },
        (metadata) => {
          setProgress(clamp(metadata.percent, 0, 100));
        }
      );

      const downloadUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `imagenes_ig_4x5_${imageOutputs.length}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      setProgress(100);
      setStatus('ZIP de imágenes generado. Descarga iniciada.');
      appendLogLine(`[ui] ZIP de imágenes generado con ${imageOutputs.length} archivo(s).`);
    } catch (zipError) {
      setError(`No se pudo empaquetar las imágenes: ${toErrorMessage(zipError)}`);
      setStatus('Error al generar ZIP de imágenes.');
    } finally {
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
    setRangeLoop(null);
    seekPreview(startSeconds);

    try {
      await player.play();
    } catch (playError) {
      setError(`No se pudo iniciar la reproducción: ${toErrorMessage(playError)}`);
    }
  };

  const handleMetadataLoaded = () => {
    const player = videoRef.current;

    if (!player || !Number.isFinite(player.duration)) {
      setVideoDurationSeconds(null);
      return;
    }

    const durationSeconds = player.duration;
    setVideoDurationSeconds(durationSeconds);
    setTimelineCursorSeconds(clamp(player.currentTime, 0, durationSeconds));

    const parsedStart = parseTimeToSeconds(startInput);

    if (parsedStart !== null && parsedStart > durationSeconds) {
      setStartInput(formatSecondsToTime(durationSeconds, false));
    }
  };

  const restoreHistoryCuts = (entry: SessionHistoryEntry) => {
    if (!entry.multiCutsTemplate || entry.multiCutsTemplate.length === 0) {
      return;
    }

    const restored = entry.multiCutsTemplate.map((item, index) => ({
      id: Date.now() + index + Math.round(Math.random() * 10_000),
      startInput: item.startInput,
      endInput: item.endInput
    }));

    setMultiCuts(restored);
    setActiveMultiCutId(restored[0]?.id ?? null);
    setMarkerTarget('multi-start');
    appendLogLine(`[ui] Se cargaron ${restored.length} cortes desde historial.`);
  };

  const clearHistory = () => {
    setHistory([]);
    persistHistory([]);
    appendLogLine('[ui] Historial limpiado.');
  };

  return (
    <main className="editor-root">
      <header className="editor-topbar">
        <div className="editor-topbar-content">
          <p className="editor-eyebrow">Media Workflow</p>
          <h1>
            FormatFlow <span>Studio</span>
          </h1>
          <p className="editor-topbar-subtitle">
            Recorte de video, formato 4:5 para Instagram y conversion de imagenes por lote con ffmpeg.wasm.
          </p>
          <div className="editor-topbar-metrics">
            <span className="topbar-chip">{selectedFile ? 'Video cargado' : 'Sin video'}</span>
            <span className="topbar-chip">Videos: {outputs.length}</span>
            <span className="topbar-chip">Imagenes: {imageOutputs.length}</span>
          </div>
        </div>
        <div className="editor-topbar-actions">
          <span className={`engine-state ${isCoreLoaded ? 'engine-state--ready' : ''}`}>
            {isCoreLoaded ? 'Motor listo' : isCoreLoading ? 'Iniciando motor...' : 'Se inicia al cargar video'}
          </span>
        </div>
      </header>

      {warning && <div className="message message--warning">{warning}</div>}
      {error && <div className="message message--error">{error}</div>}

      <section className="editor-workspace">
        <aside className="editor-sidebar">
          <section className="panel controls-grid">
            <h2>Salidas y nombres</h2>
            <label htmlFor="name-pattern">Patrón</label>
            <input
              id="name-pattern"
              value={outputNamePattern}
              onChange={(event) => setOutputNamePattern(event.target.value)}
              placeholder="{video}_{idx}_{start}_{end}.mp4"
              disabled={isProcessing}
            />
            <p className="status-text">
              Variables: <code>{'{video}'}</code> <code>{'{idx}'}</code> <code>{'{start}'}</code> <code>{'{end}'}</code>{' '}
              <code>{'{duration}'}</code>
            </p>
          </section>

          <section className="panel mode-selector-panel">
            <h2>Modos de procesamiento</h2>
            <div className="mode-switch">
              <button
                type="button"
                className={`btn btn--tab ${activeModeTab === 'simple' ? 'is-active' : ''}`}
                onClick={() => setActiveModeTab('simple')}
                disabled={isProcessing}
              >
                Simple
              </button>
              <button
                type="button"
                className={`btn btn--tab ${activeModeTab === 'auto' ? 'is-active' : ''}`}
                onClick={() => setActiveModeTab('auto')}
                disabled={isProcessing}
              >
                Auto-dividir
              </button>
              <button
                type="button"
                className={`btn btn--tab ${activeModeTab === 'multi' ? 'is-active' : ''}`}
                onClick={() => setActiveModeTab('multi')}
                disabled={isProcessing}
              >
                Múltiple
              </button>
              <button
                type="button"
                className={`btn btn--tab ${activeModeTab === 'instagram' ? 'is-active' : ''}`}
                onClick={() => setActiveModeTab('instagram')}
                disabled={isProcessing}
              >
                Instagram 4:5
              </button>
              <button
                type="button"
                className={`btn btn--tab ${activeModeTab === 'images' ? 'is-active' : ''}`}
                onClick={() => setActiveModeTab('images')}
                disabled={isProcessing}
              >
                Lote imágenes
              </button>
            </div>
          </section>

          <section className="panel mode-pages-panel">
            <div className="mode-pages-viewport">
              <div className="mode-pages-track" style={{ transform: `translateX(-${activeModeIndex * 100}%)` }}>
                <div className="mode-page">
                  <section className="controls-grid mode-page-content">
                    <h2>Recorte simple</h2>

                    <label htmlFor="start-input">Start time</label>
                    <input
                      id="start-input"
                      value={startInput}
                      onChange={(event) => setStartInput(event.target.value)}
                      placeholder="00:00:00 o 0.0"
                    />

                    <button type="button" className="btn btn--subtle" onClick={handlePreviewFromStart} disabled={!selectedFile || isProcessing}>
                      Previsualizar desde Start
                    </button>

                    <label htmlFor="duration-input">Duration</label>
                    <input
                      id="duration-input"
                      value={durationInput}
                      onChange={(event) => setDurationInput(event.target.value)}
                      placeholder="00:00:34 o 34"
                    />

                    <button type="button" className="btn btn--primary" onClick={handleTrim} disabled={!selectedFile || isProcessing}>
                      Recortar
                    </button>
                  </section>
                </div>

                <div className="mode-page">
                  <section className="controls-grid mode-page-content">
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
                      className="btn btn--primary"
                      onClick={handleAutoSplit}
                      disabled={!selectedFile || isProcessing || videoDurationSeconds === null}
                    >
                      Auto-dividir
                    </button>
                  </section>
                </div>

                <div className="mode-page">
                  <section className="mode-page-content">
                    <h2>Cortes múltiples</h2>
                    <p className="status-text">Selecciona un corte activo, arrastra para reordenar y usa preview por rango.</p>

                    <div className="multi-cut-list">
                      {multiCuts.map((cut, index) => (
                        <div
                          className={`multi-cut-row ${activeMultiCutId === cut.id ? 'multi-cut-row--active' : ''}`}
                          key={cut.id}
                          draggable={!isProcessing}
                          onDragStart={() => handleCutDragStart(cut.id)}
                          onDragOver={handleCutDragOver}
                          onDrop={() => handleCutDrop(cut.id)}
                          onClick={() => {
                            setActiveMultiCutId(cut.id);
                            setMarkerTarget('multi-start');
                          }}
                        >
                          <span className="multi-cut-index">#{index + 1}</span>
                          <div className="multi-cut-fields">
                            <input
                              value={cut.startInput}
                              onChange={(event) => updateMultiCutField(cut.id, 'startInput', event.target.value)}
                              placeholder="Inicio: 00:01:20"
                              disabled={isProcessing}
                            />
                            <input
                              value={cut.endInput}
                              onChange={(event) => updateMultiCutField(cut.id, 'endInput', event.target.value)}
                              placeholder="Fin: 00:02:05"
                              disabled={isProcessing}
                            />
                          </div>
                          <div className="multi-cut-actions">
                            <button
                              type="button"
                              className="btn btn--subtle"
                              onClick={() => previewMultiRange(cut)}
                              disabled={!selectedFile || isProcessing}
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger"
                              onClick={() => removeMultiCutRow(cut.id)}
                              disabled={isProcessing || multiCuts.length === 1}
                            >
                              Quitar
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="actions-row">
                      <button type="button" className="btn btn--subtle" onClick={addMultiCutRow} disabled={isProcessing}>
                        Agregar corte
                      </button>
                      <button type="button" className="btn btn--primary" onClick={handleMultiCut} disabled={!selectedFile || isProcessing}>
                        Generar cortes múltiples
                      </button>
                    </div>
                  </section>
                </div>

                <div className="mode-page">
                  <section className="controls-grid mode-page-content">
                    <h2>Instagram 4:5</h2>
                    <p className="status-text">
                      Convierte el video a 1080x1350 manteniendo la proporción original y agregando padding negro.
                    </p>

                    <label htmlFor="instagram-output-name">Nombre de salida</label>
                    <input
                      id="instagram-output-name"
                      value={instagramOutputName}
                      onChange={(event) => setInstagramOutputName(event.target.value)}
                      placeholder="video_ig_4x5.mp4"
                      disabled={isProcessing}
                    />

                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={handleInstagramFormat}
                      disabled={!selectedFile || isProcessing}
                    >
                      Generar 4:5
                    </button>
                  </section>
                </div>

                <div className="mode-page">
                  <section className="mode-page-content">
                    <h2>Lote imágenes 4:5</h2>
                    <p className="status-text">
                      Convierte JPG, PNG o WEBP a 1080x1350 usando <code>scale + crop</code> y salida JPG.
                    </p>

                    <div className="actions-row">
                      <label htmlFor="image-batch-input" className="file-button btn btn--primary">
                        Seleccionar imágenes
                      </label>
                      <input
                        id="image-batch-input"
                        className="visually-hidden-input"
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                        multiple
                        onChange={handleImageBatchInput}
                        disabled={isProcessing}
                      />
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={handleConvertImageBatch}
                        disabled={isProcessing || imageBatchFiles.length === 0}
                      >
                        Convertir lote
                      </button>
                    </div>

                    <p className="status-text">
                      Seleccionadas: <strong>{imageBatchFiles.length}</strong>
                    </p>

                    {imageBatchFiles.length > 0 && (
                      <ul className="image-source-list">
                        {imageBatchFiles.map((file, index) => (
                          <li key={`${file.name}_${file.size}_${file.lastModified}_${index}`}>
                            <span>{file.name}</span>
                            <span>{formatBytes(file.size)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Historial de sesiones</h2>
            <div className="logs-toolbar">
              <button type="button" className="btn btn--subtle" onClick={clearHistory} disabled={history.length === 0}>
                Limpiar historial
              </button>
            </div>

            {history.length === 0 ? (
              <p>Sin sesiones registradas.</p>
            ) : (
              <ul className="history-list">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <div>
                      <strong>{new Date(entry.createdAt).toLocaleString()}</strong>
                      <span>Modo: {modeLabel(entry.mode)}</span>
                      <span>Archivo: {entry.sourceFileName}</span>
                      <span>Salidas: {entry.outputCount}</span>
                      <span>Tamaño total: {formatBytes(entry.totalSizeBytes)}</span>
                    </div>
                    {entry.multiCutsTemplate && entry.multiCutsTemplate.length > 0 && (
                      <button type="button" className="btn btn--subtle" onClick={() => restoreHistoryCuts(entry)} disabled={isProcessing}>
                        Cargar cortes
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <section className="editor-stage">
          <section className="panel preview-panel">
            <h2>Preview</h2>
            <div className="preview-upload-row">
              <section
                className={`dropzone dropzone--inline ${isDragging ? 'dropzone--active' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={handleDrop}
              >
                <label htmlFor="video-input" className="file-button btn btn--primary">
                  Cargar video
                </label>
                <input id="video-input" type="file" accept="video/mp4,video/*" onChange={handleFileInput} />
                <p>Arrastra el video aquí o usa el botón.</p>
              </section>

              {selectedFile && (
                <section className="file-meta file-meta--inline">
                  <div className="file-meta-row">
                    <strong>Archivo:</strong>
                    <span>{selectedFile.name}</span>
                  </div>
                  <div className="file-meta-row">
                    <strong>Tamaño:</strong>
                    <span>{formatBytes(selectedFile.size)}</span>
                  </div>
                  <div className="file-meta-row">
                    <strong>Duración:</strong>
                    <span>{videoDurationSeconds === null ? 'Leyendo metadata...' : formatSecondsToTime(videoDurationSeconds)}</span>
                  </div>
                </section>
              )}
            </div>
            <video
              ref={videoRef}
              src={videoUrl || undefined}
              controls
              onLoadedMetadata={handleMetadataLoaded}
              className="video-preview"
            />
            {rangeLoop && (
              <div className="loop-preview-info">
                <span>
                  Loop activo: {formatSecondsToTime(rangeLoop.start)} - {formatSecondsToTime(rangeLoop.end)}
                </span>
                <button type="button" className="btn btn--subtle" onClick={stopRangeLoopPreview} disabled={isProcessing}>
                  Detener loop
                </button>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Timeline</h2>
            <p className="status-text">
              Arrastra los handles de inicio/fin para el corte activo. Atajos: <code>I</code> inicio, <code>O</code> fin.
            </p>

            <div className="timeline-targets">
              {timelineSelection ? (
                <>
                  <span className="timeline-selection-label">{timelineSelection.label}</span>
                  <button
                    type="button"
                    className={`btn btn--chip ${markerTarget === timelineSelection.startTarget ? 'is-active' : ''}`}
                    onClick={() => setMarkerTarget(timelineSelection.startTarget)}
                    disabled={isProcessing}
                  >
                    Editar inicio
                  </button>
                  <button
                    type="button"
                    className={`btn btn--chip ${markerTarget === timelineSelection.endTarget ? 'is-active' : ''}`}
                    onClick={() => setMarkerTarget(timelineSelection.endTarget)}
                    disabled={isProcessing}
                  >
                    Editar fin
                  </button>
                </>
              ) : (
                <span className="timeline-selection-label">Sin rango activo para ajustar en este modo.</span>
              )}
            </div>

            <div className="timeline-wrapper">
              <div ref={timelineRef} className="timeline-bar" onPointerDown={handleTimelinePointerDown}>
                {selectionStartPercent !== null && selectionEndPercent !== null && (
                  <div
                    className="timeline-selection"
                    style={{
                      left: `${selectionStartPercent}%`,
                      width: `${Math.max(selectionEndPercent - selectionStartPercent, 0.8)}%`
                    }}
                  />
                )}

                {timelineSelection && selectionStartPercent !== null && (
                  <button
                    type="button"
                    data-role="timeline-handle"
                    className={`timeline-handle timeline-handle--start ${
                      markerTarget === timelineSelection.startTarget ? 'is-active' : ''
                    }`}
                    style={{ left: `${selectionStartPercent}%` }}
                    onPointerDown={handleTimelineHandlePointerDown(timelineSelection.startTarget)}
                    disabled={isProcessing}
                    aria-label={`Inicio ${timelineSelection.label}`}
                  />
                )}

                {timelineSelection && selectionEndPercent !== null && (
                  <button
                    type="button"
                    data-role="timeline-handle"
                    className={`timeline-handle timeline-handle--end ${
                      markerTarget === timelineSelection.endTarget ? 'is-active' : ''
                    }`}
                    style={{ left: `${selectionEndPercent}%` }}
                    onPointerDown={handleTimelineHandlePointerDown(timelineSelection.endTarget)}
                    disabled={isProcessing}
                    aria-label={`Fin ${timelineSelection.label}`}
                  />
                )}

                <div className="timeline-playhead" style={{ left: `${timelinePositionPercent}%` }} />
              </div>
              <div className="timeline-labels">
                <span>
                  Vista: {formatSecondsToTime(timelineView.startSeconds, true)} -{' '}
                  {formatSecondsToTime(timelineView.endSeconds, true)}
                </span>
                <span>Cursor: {formatSecondsToTime(timelineCursorSeconds, true)}</span>
                <span>Total: {videoDurationSeconds === null ? '-' : formatSecondsToTime(videoDurationSeconds)}</span>
              </div>
            </div>

          </section>

          <section className="panel">
            <h2>Progreso</h2>
            <div className="progress-row">
              <progress value={progress} max={100} />
              <span>{Math.round(progress)}%</span>
            </div>
            <p className="status-text">{status || 'Esperando acción.'}</p>

            <div className="runtime-metrics">
              <span>Modo: {modeLabel(currentMode)}</span>
              <span>Clip actual: {currentClipTotal > 0 ? `${currentClipNumber}/${currentClipTotal}` : '-'}</span>
              <span>ETA total: {formatEta(etaSeconds)}</span>
              <span>Tiempo clip actual: {formatEta(currentClipElapsedSeconds)}</span>
            </div>

            {(currentMode === 'auto' || currentMode === 'multi' || currentMode === 'images') && isProcessing && (
              <div className="actions-row">
                <button type="button" className="btn btn--subtle" onClick={handlePauseQueue} disabled={queuePaused || queueCancelRequested}>
                  Pausar cola
                </button>
                <button type="button" className="btn btn--subtle" onClick={handleResumeQueue} disabled={!queuePaused || queueCancelRequested}>
                  Reanudar cola
                </button>
                <button type="button" className="btn btn--danger" onClick={handleCancelQueue} disabled={queueCancelRequested}>
                  Cancelar cola
                </button>
              </div>
            )}
          </section>
        </section>
      </section>

      <section className="editor-bottom">
        <section className="panel">
          <h2>Descargas</h2>
          <div className="download-group">
            <h3>Video</h3>
            {outputs.length === 0 ? (
              <p>Aún no hay videos generados.</p>
            ) : (
              <>
                <div className="downloads-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleDownloadAll}
                    disabled={isProcessing || downloadableOutputs.length < 2}
                  >
                    Descargar videos (.zip)
                  </button>
                </div>
                <ul className="download-list">
                  {outputs.map((clip) => (
                    <li key={clip.id}>
                      <div>
                        <strong>{clip.name}</strong>
                        <span>
                          {formatSecondsToTime(clip.startSeconds)} - {formatSecondsToTime(clip.startSeconds + clip.durationSeconds)}
                        </span>
                        <span>Tamaño: {formatBytes(clip.sizeBytes)}</span>
                        <span>
                          Duración real:{' '}
                          {clip.actualDurationSeconds === null ? '-' : formatSecondsToTime(clip.actualDurationSeconds, true)}
                        </span>
                        <span>
                          Verificación:{' '}
                          {clip.verifiedPlayable
                            ? 'OK'
                            : `Falló${clip.verificationError ? ` (${clip.verificationError})` : ''}`}
                        </span>
                      </div>
                      {clip.verifiedPlayable ? (
                        <a className="btn btn--primary" href={clip.url} download={clip.name}>
                          Descargar
                        </a>
                      ) : (
                        <span className="download-disabled">No descargable</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="download-group">
            <h3>Imágenes 4:5</h3>
            {imageOutputs.length === 0 ? (
              <p>Aún no hay imágenes generadas.</p>
            ) : (
              <>
                <div className="downloads-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleDownloadAllImages}
                    disabled={isProcessing || imageOutputs.length < 2}
                  >
                    Descargar imágenes (.zip)
                  </button>
                </div>
                <ul className="download-list">
                  {imageOutputs.map((image) => (
                    <li key={image.id}>
                      <div>
                        <strong>{image.name}</strong>
                        <span>Origen: {image.sourceName}</span>
                        <span>Tamaño: {formatBytes(image.sizeBytes)}</span>
                        <span>Formato: JPG 1080x1350 (4:5)</span>
                      </div>
                      <a className="btn btn--primary" href={image.url} download={image.name}>
                        Descargar
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Logs ffmpeg</h2>
          <div className="logs-toolbar">
            <button type="button" className="btn btn--subtle" onClick={() => setLogs([])} disabled={logs.length === 0}>
              Limpiar logs
            </button>
          </div>
          <pre className="logs-box">{logs.length === 0 ? 'Sin logs todavía.' : logs.join('\n')}</pre>
        </section>
      </section>
    </main>
  );
}

export default App;
