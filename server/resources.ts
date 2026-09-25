import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

// Host resource sampling for the run scheduler. CPU usage is measured over a rolling
// 2-second window (load average lags too much for admission decisions).

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let last = cpuTimes();
let cpuPercent = 0;
let memAvailable = os.freemem();

/** Memory the OS can hand out without swapping. os.freemem() ignores reclaimable cache. */
async function readAvailableMemory(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const kb = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
      if (kb) return Number(kb) * 1024;
    } catch {
      /* fall through */
    }
  }
  if (process.platform === 'darwin') {
    // free + inactive + speculative + purgeable pages are reusable on macOS.
    const out = await new Promise<string>((resolve) => execFile('vm_stat', (err, stdout) => resolve(err ? '' : stdout)));
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (name: string) => Number(out.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
    const bytes = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
    if (bytes > 0) return bytes;
  }
  return os.freemem();
}

async function tick() {
  const now = cpuTimes();
  const idle = now.idle - last.idle;
  const total = now.total - last.total;
  if (total > 0) cpuPercent = Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total))));
  last = now;
  memAvailable = await readAvailableMemory();
}

void tick();
setInterval(() => void tick(), 2000).unref();

export type ResourceSample = {
  cpuPercent: number;
  cores: number;
  load1: number;
  memAvailable: number;
  memTotal: number;
};

export function sample(): ResourceSample {
  return {
    cpuPercent,
    cores: os.cpus().length,
    load1: Math.round(os.loadavg()[0] * 100) / 100,
    memAvailable,
    memTotal: os.totalmem(),
  };
}

export const MB = 1024 * 1024;
export const fmtBytes = (b: number) => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);
