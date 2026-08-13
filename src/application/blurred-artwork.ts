import { useEffect, useRef, useState } from 'react';
import { canvasRGB as stackBlurCanvasRGB } from 'stackblur-canvas';

const blurredCache = new Map<string, string>();
const pendingRender = new Map<string, Promise<string | null>>();

const BLUR_SIZE = 320;
const BLUR_RADIUS = 24;

function renderBlurredArtwork(source: string): Promise<string | null> {
  const cached = blurredCache.get(source);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingRender.get(source);
  if (inflight) return inflight;

  const task = new Promise<string | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = BLUR_SIZE;
        canvas.height = BLUR_SIZE;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        const scale = Math.max(BLUR_SIZE / image.width, BLUR_SIZE / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const offsetX = (BLUR_SIZE - width) / 2;
        const offsetY = (BLUR_SIZE - height) / 2;
        context.drawImage(image, offsetX, offsetY, width, height);
        stackBlurCanvasRGB(canvas, 0, 0, BLUR_SIZE, BLUR_SIZE, BLUR_RADIUS);
        const dataUri = canvas.toDataURL('image/jpeg', 0.88);
        blurredCache.set(source, dataUri);
        resolve(dataUri);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = source;
  }).finally(() => pendingRender.delete(source));

  pendingRender.set(source, task);
  return task;
}

export function useBlurredArtwork(source: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    if (!source) return;
    void renderBlurredArtwork(source).then((value) => {
      if (generation.current === requestGeneration && value) setResolved(value);
    });
    return () => {
      if (generation.current === requestGeneration) generation.current += 1;
    };
  }, [source]);

  if (!source) return null;
  return blurredCache.get(source) ?? resolved;
}
