// Оттенок точки у чипа ключа выводится из значения ключа (hash → hue),
// как задано в design/README.md: одинаковый ключ — одинаковая точка.
export function keyHue(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0
  }
  return h % 360
}

export function keyDotColor(key: string): string {
  return `hsl(${keyHue(key)} 55% 42%)`
}
