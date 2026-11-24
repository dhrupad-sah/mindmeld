/** This client's version. A test keeps it equal to package.json. */
export const VERSION = "0.5.0";

/** Compares dotted numeric versions ("0.4.2" vs "0.5.0"): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
