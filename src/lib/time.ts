const SECONDS_REGEX = /^\d+(?:[.,]\d+)?$/;
const HH_MM_SS_REGEX = /^(\d+):([0-5]?\d):([0-5]?\d(?:[.,]\d+)?)$/;
const MM_SS_REGEX = /^(\d+):([0-5]?\d(?:[.,]\d+)?)$/;

const normalizeDecimalSeparator = (value: string): string => value.replace(',', '.');

export const clamp = (value: number, min: number, max: number): number => {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
};

export const parseTimeToSeconds = (input: string): number | null => {
  const value = input.trim();

  if (!value) {
    return null;
  }

  if (SECONDS_REGEX.test(value)) {
    const seconds = Number(normalizeDecimalSeparator(value));
    return Number.isFinite(seconds) ? seconds : null;
  }

  const hhmmssMatch = value.match(HH_MM_SS_REGEX);

  if (hhmmssMatch) {
    const hours = Number(hhmmssMatch[1]);
    const minutes = Number(hhmmssMatch[2]);
    const seconds = Number(normalizeDecimalSeparator(hhmmssMatch[3]));

    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds;
  }

  const mmssMatch = value.match(MM_SS_REGEX);

  if (!mmssMatch) {
    return null;
  }

  const minutes = Number(mmssMatch[1]);
  const seconds = Number(normalizeDecimalSeparator(mmssMatch[2]));

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return minutes * 60 + seconds;
};

export const formatSecondsToTime = (secondsValue: number, includeMilliseconds = true): string => {
  if (!Number.isFinite(secondsValue) || secondsValue < 0) {
    return '00:00:00';
  }

  const millisecondsTotal = Math.round(secondsValue * 1000);
  const hours = Math.floor(millisecondsTotal / 3_600_000);
  const minutes = Math.floor((millisecondsTotal % 3_600_000) / 60_000);
  const seconds = Math.floor((millisecondsTotal % 60_000) / 1_000);
  const milliseconds = millisecondsTotal % 1_000;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (!includeMilliseconds || milliseconds === 0) {
    return `${hh}:${mm}:${ss}`;
  }

  const mmm = String(milliseconds).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
};

export const formatSecondsForFfmpeg = (secondsValue: number): string => {
  if (!Number.isFinite(secondsValue) || secondsValue < 0) {
    return '00:00:00.000';
  }

  const millisecondsTotal = Math.round(secondsValue * 1000);
  const hours = Math.floor(millisecondsTotal / 3_600_000);
  const minutes = Math.floor((millisecondsTotal % 3_600_000) / 60_000);
  const seconds = Math.floor((millisecondsTotal % 60_000) / 1_000);
  const milliseconds = millisecondsTotal % 1_000;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(milliseconds).padStart(3, '0');

  return `${hh}:${mm}:${ss}.${mmm}`;
};

export const formatBytes = (sizeInBytes: number): string => {
  if (!Number.isFinite(sizeInBytes) || sizeInBytes < 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = sizeInBytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};
