import { execFile } from 'node:child_process';
import { DetectedDb } from '../model';
import { parseDockerInspect } from './dockerInspect';

function run(cmd: string, args: string[], timeout = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export interface DockerScanResult {
  databases: DetectedDb[];
  /** Why scanning failed (Docker not running, CLI missing…). */
  error?: string;
}

/** Runs `docker ps` + `docker inspect` to find running database containers. */
export async function scanDocker(dockerPath: string): Promise<DockerScanResult> {
  try {
    const ids = (await run(dockerPath, ['ps', '-q'])).split(/\s+/).filter(Boolean);
    if (!ids.length) return { databases: [] };
    const inspect = await run(dockerPath, ['inspect', ...ids]);
    return { databases: parseDockerInspect(JSON.parse(inspect)) };
  } catch (e) {
    const msg = (e as Error).message;
    if (/ENOENT/.test(msg)) return { databases: [], error: 'Docker CLI not found' };
    if (/daemon|Cannot connect/i.test(msg)) return { databases: [], error: 'Docker is not running' };
    return { databases: [], error: msg.split('\n')[0] };
  }
}
