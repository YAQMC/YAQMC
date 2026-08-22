interface ScrollSpring {
  frame: number | null;
  cancel: () => void;
}

interface LineWaveSpring {
  element: HTMLElement;
  position: number;
  velocity: number;
  delayMs: number;
}

interface LyricScrollState {
  offset: number;
  spring: ScrollSpring | null;
  wave: LineWaveSpring[] | null;
}

const scrollStates = new WeakMap<Element, LyricScrollState>();

export function scrollStateFor(scrollArea: Element): LyricScrollState {
  let state = scrollStates.get(scrollArea);
  if (!state) {
    state = { offset: 0, spring: null, wave: null };
    scrollStates.set(scrollArea, state);
  }
  return state;
}

export function cancelScrollSpring(scrollArea: Element | null): void {
  if (!scrollArea) return;
  const state = scrollStateFor(scrollArea);
  state.spring?.cancel();
  state.spring = null;
  clearLineWave(state);
}

function clearLineWave(state: LyricScrollState): void {
  if (!state.wave) return;
  for (const line of state.wave) line.element.style.removeProperty('transform');
  state.wave = null;
}

const SPRING_STIFFNESS = 120;
const SPRING_DAMPING = 15;
const SPRING_MASS = 1;
const DEFAULT_SPRING_STEP_SECONDS = 1 / 60;
const MAX_SPRING_STEP_SECONDS = 1 / 20;

export function lyricScrollSpringStepSeconds(
  previousTimestamp: number | null,
  timestamp: number,
): number {
  if (previousTimestamp === null || !Number.isFinite(timestamp)) {
    return DEFAULT_SPRING_STEP_SECONDS;
  }
  const elapsed = (timestamp - previousTimestamp) / 1_000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return DEFAULT_SPRING_STEP_SECONDS;
  // A hidden or briefly stalled renderer must catch up to the visual clock,
  // but never take one huge, unstable integration step.
  return Math.min(MAX_SPRING_STEP_SECONDS, elapsed);
}

export function setLyricOffset(
  scrollArea: HTMLDivElement,
  content: HTMLDivElement,
  offset: number,
): void {
  const state = scrollStateFor(scrollArea);
  state.offset = offset;
  content.style.transform = `translate3d(0, ${-offset.toFixed(2)}px, 0)`;
}

export function lyricScrollBounds(scrollArea: HTMLDivElement, content: HTMLDivElement): number {
  return Math.max(0, content.getBoundingClientRect().height - scrollArea.clientHeight);
}

const WAVE_MAX_PX = 30;
const WAVE_MIN_TRAVEL_PX = 16;
const WAVE_FULL_TRAVEL_PX = 120;
const WAVE_CASCADE_MS = 44;

export function lyricScrollWaveIntensity(travelPx: number): number {
  if (!Number.isFinite(travelPx) || travelPx < WAVE_MIN_TRAVEL_PX) return 0;
  return Math.min(1, (travelPx - WAVE_MIN_TRAVEL_PX) / (WAVE_FULL_TRAVEL_PX - WAVE_MIN_TRAVEL_PX));
}

function buildLineWave(
  content: HTMLDivElement,
  targetLineIndex: number,
  delta: number,
): LineWaveSpring[] {
  const intensity = lyricScrollWaveIntensity(Math.abs(delta));
  if (intensity === 0) return [];
  const lines = Array.from(content.querySelectorAll<HTMLElement>('[data-line-index]'));
  const springs: LineWaveSpring[] = [];
  for (const line of lines) {
    const index = Number(line.dataset.lineIndex);
    if (!Number.isFinite(index)) continue;
    const distance = Math.abs(index - targetLineIndex);
    // Lines ahead of the scroll direction lead the shared motion; lines behind trail it,
    // so the gap between adjacent lines flexes as the wave passes instead of staying rigid.
    const direction =
      delta > 0 ? (index < targetLineIndex ? -1 : 1) : index > targetLineIndex ? 1 : -1;
    const amplitude = Math.min(distance, 2) * (WAVE_MAX_PX / 2) * intensity;
    springs.push({
      element: line,
      position: direction * amplitude,
      velocity: 0,
      delayMs: Math.max(0, distance - 1) * WAVE_CASCADE_MS,
    });
  }
  return springs;
}

function settleLineWave(state: LyricScrollState): void {
  if (!state.wave) return;
  for (const line of state.wave) line.element.style.removeProperty('transform');
  state.wave = null;
}

export function springScrollTo(
  scrollArea: HTMLDivElement,
  content: HTMLDivElement,
  targetOffset: number,
  options: { force?: boolean; onArrive?: () => void; targetLineIndex?: number } = {},
): void {
  cancelScrollSpring(scrollArea);
  const state = scrollStateFor(scrollArea);
  const distance = Math.abs(targetOffset - state.offset);
  if (!options.force && distance < 1) {
    options.onArrive?.();
    return;
  }
  if (options.force && distance < 1) {
    setLyricOffset(scrollArea, content, targetOffset);
    options.onArrive?.();
    return;
  }
  const arrivePx = Math.max(16, scrollArea.clientHeight * 0.1);
  const waveEnabled =
    options.targetLineIndex !== undefined &&
    document.documentElement.getAttribute('data-graphics-mode') !== 'software' &&
    document.documentElement.getAttribute('data-graphics-mode') !== 'safe';
  const wave =
    waveEnabled && lyricScrollWaveIntensity(distance) > 0
      ? buildLineWave(content, options.targetLineIndex ?? 0, targetOffset - state.offset)
      : null;
  state.wave = wave;
  let arrived = false;
  const arrive = () => {
    if (arrived) return;
    arrived = true;
    options.onArrive?.();
  };
  let position = state.offset;
  let velocity = 0;
  let frame: number | null = null;
  let previousTimestamp: number | null = null;

  const cancel = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    state.spring = null;
    settleLineWave(state);
  };

  const step = (timestamp: number) => {
    frame = null;
    const stepSeconds = lyricScrollSpringStepSeconds(previousTimestamp, timestamp);
    previousTimestamp = timestamp;
    const acceleration =
      (-SPRING_STIFFNESS * (position - targetOffset) - SPRING_DAMPING * velocity) / SPRING_MASS;
    velocity += acceleration * stepSeconds;
    position += velocity * stepSeconds;
    setLyricOffset(scrollArea, content, position);
    if (state.wave) {
      const stepMs = stepSeconds * 1000;
      for (const line of state.wave) {
        if (line.delayMs > 0) {
          line.delayMs -= stepMs;
          continue;
        }
        const waveAcceleration =
          (-SPRING_STIFFNESS * line.position - SPRING_DAMPING * line.velocity) / SPRING_MASS;
        line.velocity += waveAcceleration * stepSeconds;
        line.position += line.velocity * stepSeconds;
        line.element.style.transform = `translate3d(0, ${line.position.toFixed(2)}px, 0)`;
      }
    }
    if (!arrived && Math.abs(position - targetOffset) <= arrivePx) arrive();
    if (Math.abs(position - targetOffset) > 0.6 || Math.abs(velocity) > 0.6) {
      frame = window.requestAnimationFrame(step);
    } else {
      setLyricOffset(scrollArea, content, targetOffset);
      cancel();
      arrive();
    }
  };

  state.spring = { frame, cancel };
  step(performance.now());
}

export function centerLyricLine(
  scrollArea: HTMLDivElement | null,
  content: HTMLDivElement | null,
  lineIndex: number,
  reducedMotion: boolean,
  options: { followAnchor?: number; force?: boolean; onArrive?: () => void } = {},
): void {
  if (!scrollArea || !content || lineIndex < 0) return;
  const line = content.querySelector<HTMLElement>(`[data-line-index="${lineIndex}"]`);
  if (!line) return;
  const areaRect = scrollArea.getBoundingClientRect();
  const previousContentVisibility = line.style.getPropertyValue('content-visibility');
  line.style.setProperty('content-visibility', 'visible');
  const lineRect = line.getBoundingClientRect();
  if (previousContentVisibility) {
    line.style.setProperty('content-visibility', previousContentVisibility);
  } else {
    line.style.removeProperty('content-visibility');
  }
  const state = scrollStateFor(scrollArea);
  const followAnchor = options.followAnchor ?? 0.35;
  const top =
    state.offset +
    lineRect.top -
    areaRect.top -
    scrollArea.clientHeight * followAnchor +
    lineRect.height / 2;
  const target = Math.min(Math.max(0, top), lyricScrollBounds(scrollArea, content));
  if (reducedMotion) {
    setLyricOffset(scrollArea, content, target);
    options.onArrive?.();
    return;
  }
  springScrollTo(scrollArea, content, target, {
    force: options.force,
    onArrive: options.onArrive,
    targetLineIndex: lineIndex,
  });
}
