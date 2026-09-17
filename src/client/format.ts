/** Formatting + tiny helpers shared by the dsh-switch client surfaces. */

export type TFn = (key: string, params?: Record<string, unknown>) => string

export function hostOf(url: string | null): string {
  if (url === null || url === '') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
