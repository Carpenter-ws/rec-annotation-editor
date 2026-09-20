/**
 * Deterministic stress fixture: `count` REC lines inside a 1920x1080 frame.
 * Every label stays a free-text expression ending with the reserved `0`.
 */
export function makeStressAnnotations(count = 500): string {
  return Array.from({ length: count }, (_, index) => {
    const x1 = (index * 37) % 1850;
    const y1 = (index * 53) % 1020;
    return `${x1}.00 ${y1}.00 ${x1 + 40}.00 ${y1 + 30}.00 target ${index + 1} 0`;
  }).join("\n");
}
