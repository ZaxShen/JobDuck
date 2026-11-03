export const allChecked = (value: readonly string[], known: readonly string[]) =>
  known.length > 0 && known.every((option) => value.includes(option))

export function toggleChecked(value: readonly string[], known: readonly string[], option: string, on: boolean): string[] {
  const chosen = new Set(value)
  if (on) chosen.add(option)
  else chosen.delete(option)
  return [...known.filter((v) => chosen.has(v)), ...[...chosen].filter((v) => !known.includes(v))]
}

export function setAllChecked(value: readonly string[], known: readonly string[], on: boolean): string[] {
  const others = value.filter((v) => !known.includes(v))
  return on ? [...known, ...others] : others
}
