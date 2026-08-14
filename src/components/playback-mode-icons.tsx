import type { VisualPlaybackMode } from '../application/playback-mode';

interface PlaybackModeIconProps {
  size?: number;
}

const svgProps = (size: number, mode: VisualPlaybackMode) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    focusable: false,
    'data-playback-icon': mode,
  }) as const;

export function SequentialPlaybackIcon({ size = 15 }: PlaybackModeIconProps) {
  return (
    <svg {...svgProps(size, 'sequential')}>
      <path
        d="M2.5 4.25h7.5M2.5 8h9.25M2.5 11.75h6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11.35 10.15 13.7 12l-2.35 1.85"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShufflePlaybackIcon({ size = 15 }: PlaybackModeIconProps) {
  return (
    <svg {...svgProps(size, 'shuffle')}>
      <path
        d="M2.25 4.25h2.2c.9 0 1.72.45 2.22 1.2l3.16 4.7c.5.75 1.32 1.2 2.22 1.2h1.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.35 9.5 13.7 11.35 11.35 13.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.25 11.75h2.2c.9 0 1.72-.45 2.22-1.2L7.4 9.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 6.55 9.85 4.85c.5-.75 1.32-1.2 2.22-1.2h1.68"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.35 2.8 13.7 4.65 11.35 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RepeatOnePlaybackIcon({ size = 15 }: PlaybackModeIconProps) {
  return (
    <svg {...svgProps(size, 'repeat-one')}>
      <RepeatLoopPaths />
      <path
        d="M7.35 5.7 8.2 5.1v5.7"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RepeatAllPlaybackIcon({ size = 15 }: PlaybackModeIconProps) {
  return (
    <svg {...svgProps(size, 'repeat-all')}>
      <RepeatLoopPaths />
    </svg>
  );
}

function RepeatLoopPaths() {
  return (
    <>
      <path
        d="M4.1 6.15V4.7h6.2a2.55 2.55 0 0 1 2.55 2.55"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.2 3.85 4.1 4.7l.9-.85"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.9 9.85v1.45H5.7A2.55 2.55 0 0 1 3.15 8.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.8 12.15 11.9 11.3l-.9.85"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

export function PlaybackModeGlyph({
  mode,
  size = 15,
}: {
  mode: VisualPlaybackMode;
  size?: number;
}) {
  switch (mode) {
    case 'shuffle':
      return <ShufflePlaybackIcon size={size} />;
    case 'repeat-one':
      return <RepeatOnePlaybackIcon size={size} />;
    case 'repeat-all':
      return <RepeatAllPlaybackIcon size={size} />;
    default:
      return <SequentialPlaybackIcon size={size} />;
  }
}

export function SelectedModeMark({ size = 12 }: PlaybackModeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable="false"
      data-playback-selected-mark="true"
    >
      <path
        d="M2.2 6.15 4.7 8.55 9.8 3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
