import type { Config } from '../config.js';
import type { FaceEngine } from './index.js';

/** The face engine the server uses: YuNet + SFace through OpenCV, inside this process (worker threads). */
export async function defaultFace(cfg: Pick<Config, 'faceModelsDir' | 'faceWorkers' | 'faceModel'>): Promise<FaceEngine & { close(): Promise<void> }> {
  const { localFace } = await import('./local.js'); // loaded only when used: tests bring their own engine
  return localFace({ modelsDir: cfg.faceModelsDir, workers: cfg.faceWorkers, model: cfg.faceModel });
}
