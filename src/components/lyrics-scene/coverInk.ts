export function coverInk(hexColor: string): { ink: string; contrast: string } {
  const normalized = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { ink: '#ffffff', contrast: '#10140c' };
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62
    ? { ink: '#171a12', contrast: '#ffffff' }
    : { ink: '#ffffff', contrast: '#10140c' };
}
