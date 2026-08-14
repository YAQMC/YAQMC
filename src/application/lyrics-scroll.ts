interface ScrollSpring {
  frame: number | null;
  cancel: () => void;
}

interface LyricScrollState {
  offset: number;
  spring: ScrollSpring | null;
}

const scrollStates = new WeakMap<Element, LyricScrollState>();

export function scrollStateFor(scrollArea: Element): LyricScrollState {
  let state = scrollStates.get(scrollArea);
  if (!state) {
    state = { offset: 0, spring: null };
    scrollStates.set(scrollArea, state);
  }
  return state;
}

export function cancelScrollSpring(scrollArea: Element | null): void {
  if (!scrollArea) return;
  scrollStateFor(scrollArea).spring?.cancel();
  const state = scrollStates.get(scrollArea);
  if (state) state.spring = null;
}

const SPRING_STIFFNESS = 120;
const SPRING_DAMPING = 15;
const SPRING_MASS = 1;
const SPRING_STEP_SECONDS = 1 / 60;

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

export function springScrollTo(
  scrollArea: HTMLDivElement,
  content: HTMLDivElement,
  targetOffset: number,
  options: { force?: boolean } = {},
): void {
  cancelScrollSpring(scrollArea);
  const state = scrollStateFor(scrollArea);
  if (!options.force && Math.abs(targetOffset - state.offset) < 1) return;
  if (options.force && Math.abs(targetOffset - state.offset) < 1) {
    setLyricOffset(scrollArea, content, targetOffset);
    return;
  }
  let position = state.offset;
  let velocity = 0;
  let frame: number | null = null;

  const cancel = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    state.spring = null;
  };

  const step = () => {
    frame = null;
    const acceleration =
      (-SPRING_STIFFNESS * (position - targetOffset) - SPRING_DAMPING * velocity) / SPRING_MASS;
    velocity += acceleration * SPRING_STEP_SECONDS;
    position += velocity * SPRING_STEP_SECONDS;
    setLyricOffset(scrollArea, content, position);
    if (Math.abs(position - targetOffset) > 0.6 || Math.abs(velocity) > 0.6) {
      frame = window.requestAnimationFrame(step);
    } else {
      setLyricOffset(scrollArea, content, targetOffset);
      cancel();
    }
  };

  state.spring = { frame, cancel };
  step();
}

export function centerLyricLine(
  scrollArea: HTMLDivElement | null,
  content: HTMLDivElement | null,
  lineIndex: number,
  reducedMotion: boolean,
  options: { followAnchor?: number; force?: boolean } = {},
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
    return;
  }
  springScrollTo(scrollArea, content, target, { force: options.force });
}
