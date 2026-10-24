import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

const JSONL_ROTATE_BYTES = 50 * 1024 * 1024;

const TAIL_CHUNK_BYTES = 64 * 1024;

function rotatedPath(path: string): string {
  return `${path}.1`;
}

export function appendRecord(path: string, value: unknown, maxBytes = JSONL_ROTATE_BYTES): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size >= maxBytes) {
      renameSync(path, rotatedPath(path));
    }
  } catch {}
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function tailLines(path: string, n: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let chunk = TAIL_CHUNK_BYTES;
    let buffer = Buffer.alloc(0);
    let lines: string[] = [];
    while (position > 0) {
      const length = Math.min(chunk, position);
      position -= length;
      const piece = Buffer.alloc(length);
      readSync(fd, piece, 0, length, position);
      buffer = Buffer.concat([piece, buffer]);
      lines = buffer.toString("utf8").split("\n");
      const complete = position > 0 ? lines.length - 1 : lines.length;
      if (complete > n) {
        break;
      }
      chunk *= 2;
    }
    if (position > 0) {
      lines = lines.slice(1);
    }
    return lines;
  } finally {
    closeSync(fd);
  }
}

function parseLines<T>(lines: string[]): T[] {
  const records: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {}
  }
  return records;
}

export function readTail<T>(path: string, n: number): T[] {
  const current = existsSync(path) ? parseLines<T>(tailLines(path, n)) : [];
  if (current.length >= n || !existsSync(rotatedPath(path))) {
    return current.slice(-n);
  }
  const older = parseLines<T>(tailLines(rotatedPath(path), n - current.length));
  return [...older, ...current].slice(-n);
}
