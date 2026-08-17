export type SurfaceCapabilitySnapshot = {
  backend: string;
  reliableAlwaysOnTop: boolean;
  reliableClickThrough: boolean;
  limitations: readonly string[];
};

export function isNativeWaylandBackend(backend: string): boolean {
  const normalized = backend.trim().toLowerCase();
  if (normalized.includes('xwayland') || normalized.includes('x11')) {
    return false;
  }
  return /native[-_]?wayland|wayland[-_]?native|\bwayland\b/.test(normalized);
}

export function shouldShowSurfaceCapabilityBanner(
  caps: SurfaceCapabilitySnapshot | null | undefined,
): caps is SurfaceCapabilitySnapshot {
  if (!caps) return false;
  return (
    isNativeWaylandBackend(caps.backend) ||
    caps.reliableAlwaysOnTop === false ||
    caps.reliableClickThrough === false ||
    caps.limitations.length > 0
  );
}

export function SurfaceCapabilityBanner({
  capabilities,
}: {
  capabilities: SurfaceCapabilitySnapshot | null | undefined;
}) {
  if (!shouldShowSurfaceCapabilityBanner(capabilities)) {
    return null;
  }
  return (
    <div
      className="settings-capability-note"
      role="status"
      data-backend={capabilities.backend}
      data-reliable-always-on-top={String(capabilities.reliableAlwaysOnTop)}
      data-reliable-click-through={String(capabilities.reliableClickThrough)}
    >
      {capabilities.limitations.map((limitation) => (
        <p key={limitation}>{limitation}</p>
      ))}
    </div>
  );
}
