// The one place the wrapper reads which operating system it runs on. Every
// Windows-only branch asks isWindows() here, never process.platform directly,
// so the tests can run those branches on Linux by switching this seam.
let current: string = process.platform;

export function platform(): string {
  return current;
}

export function isWindows(): boolean {
  return current === 'win32';
}

// Test seam only: simulate another platform; null restores the real one.
export function setPlatformForTests(p: string | null): void {
  current = p ?? process.platform;
}
