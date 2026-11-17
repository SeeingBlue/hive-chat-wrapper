// Windows only: how the CLI adapter turns its configured command into a program
// it can start directly, without a shell (Design §3.1, §7.6).
//
// A model CLI installed with npm reaches PATH as a .cmd shim, and Node refuses to
// spawn a .cmd/.bat file without a shell (the CVE-2024-27980 hardening). A batch
// file only ever runs inside cmd.exe, and cmd.exe parses its whole command line
// as shell syntax, so chat text in an argument could start other commands (and a
// newline ends the line). The wrapper therefore never starts cmd.exe:
//
//   1. The command is resolved against PATH and PATHEXT, preferring a native
//      executable (.exe or .com) wherever it is on PATH. The current directory is
//      not searched, and neither is any relative PATH entry.
//   2. If the only resolution is a batch file, it is accepted only when it is one
//      of the two shims npm's cmd-shim writes (what `npm install -g` puts on PATH).
//      The shim's real target is then started directly, as the shim would start
//      it: node.exe with the script (and any node flags from its #! line), or the
//      native executable the shim runs. The arguments reach that program's own
//      command line, quoted by Node for the standard Windows argument parser.
//   3. Anything else is refused at startup with an error naming the limitation.
//
// Pure functions over a small file probe, so the tests can run them on any OS.
import fs from 'node:fs';
import path from 'node:path';

const win = path.win32;

export interface FileProbe {
  isFile(p: string): boolean;
  readText(p: string): string;
}

export const realFileProbe: FileProbe = {
  isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText(p) {
    return fs.readFileSync(p, 'utf8');
  },
};

export interface SpawnTarget {
  file: string; // a native executable, started with shell: false
  prefixArgs: string[]; // go before the profile's arguments
  via: string | null; // the npm shim it was unwrapped from, if any
}

const NATIVE = new Set(['.exe', '.com']);
const BATCH = new Set(['.cmd', '.bat']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// Windows environment variable names are case-insensitive.
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) return env[k];
  return undefined;
}

function extensions(env: Record<string, string | undefined>): string[] {
  const list = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9_]+$/.test(e));
  return list.length > 0 ? list : DEFAULT_PATHEXT.toLowerCase().split(';');
}

function pathDirs(env: Record<string, string | undefined>): string[] {
  return (envValue(env, 'PATH') ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && win.isAbsolute(d));
}

function refuse(command: string, found: string, why: string): Error {
  return new Error(
    `cli adapter: "${command}" resolves to the batch file ${found}. On Windows a batch file runs only inside cmd.exe, ` +
      `which reads every argument as shell syntax, so chat text could run commands; the wrapper never starts cmd.exe. ` +
      `${why} Set "command" to the CLI's native executable (.exe) instead.`,
  );
}

// The two shapes npm's cmd-shim writes (checked against cmd-shim 7), after CRLF
// is normalised to LF. A shim that sets variables, runs another interpreter, or
// differs in any other way matches neither and is refused.
const SHIM_HEAD = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n';
const NODE_SHIM_BODY =
  /^\nIF EXIST "%dp0%\\([^"\n%]+)\.exe" \(\n {2}SET "_prog=%dp0%\\\1\.exe"\n\) ELSE \(\n {2}SET "_prog=\1"\n {2}SET PATHEXT=%PATHEXT:;\.JS;=;%\n\)\n\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" ([^"\n%]*) "%dp0%\\([^"\n%]+)" %\*\n?$/;
const DIRECT_SHIM_BODY = /^"%dp0%\\([^"\n%]+)" +%\*\n?$/;
// Node flags carried over from a script's #! line.
const NODE_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9_.=:,+\/-]*$/;

function shimTarget(rel: string): boolean {
  return rel.length > 0 && !win.isAbsolute(rel) && !rel.includes(':');
}

function unwrapShim(command: string, shim: string, env: Record<string, string | undefined>, probe: FileProbe): SpawnTarget {
  const text = probe.readText(shim).replace(/\r\n/g, '\n');
  const dir = win.dirname(shim);
  const body = text.startsWith(SHIM_HEAD) ? text.slice(SHIM_HEAD.length) : null;
  const node = body?.match(NODE_SHIM_BODY);
  if (node) {
    const [, prog, flagText, rel] = node;
    if (prog !== 'node') throw refuse(command, shim, `It is an npm shim that runs ${prog}, not node, so the wrapper cannot start its target directly.`);
    const flags = flagText.split(/\s+/).filter((f) => f.length > 0);
    if (flags.some((f) => !NODE_FLAG.test(f))) throw refuse(command, shim, 'Its node options are not plain flags the wrapper can pass on unchanged.');
    if (!shimTarget(rel)) throw refuse(command, shim, 'Its script path is not relative to the shim.');
    const script = win.join(dir, rel);
    if (!probe.isFile(script)) throw refuse(command, shim, `Its script ${script} does not exist.`);
    // As the shim does: node.exe beside it, else node from PATH (here: native only).
    const local = win.join(dir, 'node.exe');
    let nodeExe: string;
    if (probe.isFile(local)) nodeExe = local;
    else {
      const found = searchPath('node', env, probe);
      const native = found.find((m) => NATIVE.has(m.ext));
      if (!native) throw refuse(command, shim, 'It runs node, and node.exe is not on PATH.');
      nodeExe = native.path;
    }
    return { file: nodeExe, prefixArgs: [...flags, script], via: shim };
  }
  const direct = body?.match(DIRECT_SHIM_BODY);
  if (direct) {
    const rel = direct[1];
    if (!shimTarget(rel)) throw refuse(command, shim, 'Its target path is not relative to the shim.');
    const target = win.join(dir, rel);
    if (!NATIVE.has(win.extname(target).toLowerCase())) throw refuse(command, shim, `It is an npm shim for ${target}, which is not a native executable.`);
    if (!probe.isFile(target)) throw refuse(command, shim, `Its target ${target} does not exist.`);
    return { file: target, prefixArgs: [], via: shim };
  }
  throw refuse(command, shim, 'It is not one of the npm shims the wrapper can unwrap.');
}

interface Match {
  path: string;
  ext: string;
}

// Every PATH match for a bare program name, in PATH order and, within one
// folder, in PATHEXT order.
function searchPath(name: string, env: Record<string, string | undefined>, probe: FileProbe): Match[] {
  const exts = extensions(env);
  const ext = win.extname(name).toLowerCase();
  const names = ext && exts.includes(ext) ? [name] : exts.map((e) => name + e);
  const out: Match[] = [];
  for (const dir of pathDirs(env)) {
    for (const n of names) {
      const p = win.join(dir, n);
      if (probe.isFile(p)) out.push({ path: p, ext: win.extname(n).toLowerCase() });
    }
  }
  return out;
}

export function resolveWindowsCommand(command: string, env: Record<string, string | undefined>, probe: FileProbe = realFileProbe): SpawnTarget {
  let matches: Match[];
  if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) {
    if (!win.isAbsolute(command)) throw new Error(`cli adapter: on Windows "command" must be a program name found on PATH or an absolute path; got ${command}`);
    const ext = win.extname(command).toLowerCase();
    const candidates = ext ? [command] : extensions(env).map((e) => command + e);
    matches = candidates.filter((c) => probe.isFile(c)).map((c) => ({ path: c, ext: win.extname(c).toLowerCase() }));
  } else {
    matches = searchPath(command, env, probe);
  }
  const native = matches.find((m) => NATIVE.has(m.ext));
  if (native) return { file: native.path, prefixArgs: [], via: null };
  const batch = matches.find((m) => BATCH.has(m.ext));
  if (batch) return unwrapShim(command, batch.path, env, probe);
  if (matches.length > 0) {
    throw new Error(`cli adapter: "${command}" resolves to ${matches[0].path}, which is not a native executable; the wrapper starts only .exe or .com programs on Windows. Set "command" to the CLI's .exe.`);
  }
  throw new Error(`cli adapter: "${command}" was not found${/[\\/]/.test(command) ? '' : ' on PATH'} as a .exe, .com or npm .cmd shim`);
}

// Windows passes one command line, at most 32,767 characters, which the child
// splits back into arguments. Node (libuv) quotes each argument so the standard
// parser recovers it exactly; this counts the characters that quoting produces.
export const WINDOWS_COMMAND_LINE_MAX = 32_767;

export function quotedArgLength(arg: string): number {
  if (arg.length === 0) return 2;
  if (!/[ \t"]/.test(arg)) return arg.length;
  if (!/["\\]/.test(arg)) return arg.length + 2;
  let n = 2;
  let backslashes = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg.charCodeAt(i);
    if (c === 0x5c) {
      backslashes++;
      n++;
    } else if (c === 0x22) {
      n += backslashes + 2; // the run of backslashes doubled, then \"
      backslashes = 0;
    } else {
      backslashes = 0;
      n++;
    }
  }
  return n + backslashes; // trailing backslashes doubled before the closing quote
}

export function commandLineLength(file: string, args: string[]): number {
  return [file, ...args].reduce((sum, a) => sum + quotedArgLength(a), 0) + args.length;
}
