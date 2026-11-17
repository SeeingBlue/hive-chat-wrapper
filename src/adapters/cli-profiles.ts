// Profile registry for the vendor CLI adapter: how each second-brain CLI is
// launched, what the wrapper seeds into its owned directories, and how its
// event stream is read.
//
// Probe standards (see CliAdapter.probe):
// - literal: declared tool list present and empty, zero tool events of any
//   kind, canary absent. Profiles: claude-code, grok.
// - blocked-execution (opt-in per config, pending an owner decision): the model
//   may attempt tools, but every attempt must be marked blocked by the vendor
//   CLI under a deny/disable configuration the wrapper wrote for that run.
//   Profiles: cursor, antigravity, codex. These three can never pass literal.
//
// Parsers fail closed: an event that plausibly represents a tool execution but
// has no recognized shape counts as executed, and a recognized tool event whose
// outcome is unclear (or that never finished) counts as unknown. Both stop the
// wrapper.
import type { Usage } from './types.ts';

export type ProfileName = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'grok';
export type ProbeStandard = 'literal' | 'blocked-execution';
export type ToolStatus = 'executed' | 'blocked' | 'unknown';

export interface ToolEvent {
  name: string;
  status: ToolStatus;
  target?: string; // path a tool call was aimed at, when the format carries one (cursor discovery scoping)
}

export interface ParsedRun {
  text: string;
  usage: Usage;
  initSeen: boolean;
  declaredTools: unknown[] | null; // null when the format carries no list
  mcpServers: unknown[] | null;
  toolEvents: ToolEvent[];
  permissionMode: string | null;
  isError: boolean;
  errorHint: string;
}

export interface EventParser {
  out: ParsedRun;
  onLine(line: string): void;
  finish(): void; // resolves text and tool events left unfinished
}

export type DirBase = 'root' | 'config' | 'home' | 'persist';

export interface SeedFile {
  base: DirBase;
  path: string; // relative to base
  content: string;
  denyConfig?: boolean; // part of the deny/disable configuration the blocked-execution standard relies on
}

export interface CredentialFile {
  source: string; // relative to <stateDir>/keys
  target: string; // relative to the owned home dir
}

export interface CliProfile {
  id: ProfileName;
  argsTemplate: string[];
  extraEnv: Record<string, string>;
  envAllowlist: string[];
  credentialEnv: string | null;
  // Env vars pointing at the owned directories. HOME is always the owned home;
  // on Windows so are USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA and LOCALAPPDATA.
  envDirs: Array<{ name: string; base: DirBase; rel?: string }>;
  seedFiles: SeedFile[];
  credentialFiles: CredentialFile[];
  standards: ProbeStandard[]; // the standards this profile can ever pass
  createParser(): EventParser;
  // Arguments that must never reach this CLI, even from a config override.
  forbiddenArgs: RegExp | null;
  // Project-level config in the working directory that could widen permissions.
  projectConfigPaths: string[];
  // blocked-execution only: why the filled arguments do not carry the deny config.
  denyArgsProblem?(args: string[]): string | null;
  expectedPermissionMode?: string;
  // Tool names whose execution the blocked-execution standard tolerates for
  // this profile: the vendor's internal orchestration steps, which its
  // permission system does not govern and which cannot touch the world
  // themselves (a spawned subagent inherits the same deny rules). Effect
  // tools are never listed here. Set for antigravity only, by the operator's
  // decision of 2026-10-30.
  orchestrationTools?: string[];
  // Tool names the blocked-execution standard tolerates as read-only
  // discovery when — and only when — the call is scoped inside the agent's
  // own directories (its working directory or its CLI home). Set for cursor
  // only, by the operator's decision of 2026-10-30: Cursor's permission
  // tokens govern shell/file/web/MCP calls but not its glob/grep discovery
  // tools. getMcpToolsToolCall carries no path; it lists the agent's own
  // (wrapper-configured, empty) MCP registry and is tolerated unscoped.
  discoveryTools?: string[];
  limitPattern: RegExp;
}

const LIMIT_RE = /rate.?limit|usage limit|limit reached|quota/i;
const VENDOR_LIMIT_RE = /rate.?limit|usage limit|limit reached|quota|too many requests|\b429\b|resource.?exhausted|out of credits|insufficient credits/i;

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function emptyRun(): ParsedRun {
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    initSeen: false,
    declaredTools: null,
    mcpServers: null,
    toolEvents: [],
    permissionMode: null,
    isError: false,
    errorHint: '',
  };
}

function jsonEvent(line: string): any {
  try {
    const ev = JSON.parse(line);
    return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function errorText(ev: any): string {
  const e = ev?.error;
  const msg = str(ev?.message) || str(e) || str(e?.message) || str(ev?.data);
  return msg.slice(0, 300);
}

const TOOLISH_RE = /tool|function_?call|command_?exec|run_?command|shell|mcp|file_?change|patch|web_?search|browser|computer_?(use|call)|subagent/i;
const LABEL_KEYS = new Set(['type', 'subtype', 'kind', 'event', 'name', 'step_type']);

// Reads key names and label values only, never free text, so a reply that
// merely mentions a tool is not a tool event.
export function looksToolish(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== 'object' || depth > 5) return false;
  for (const [k, val] of Object.entries(v)) {
    if (TOOLISH_RE.test(k)) return true;
    if (LABEL_KEYS.has(k) && typeof val === 'string' && TOOLISH_RE.test(val)) return true;
    if (looksToolish(val, depth + 1)) return true;
  }
  return false;
}

function labelOf(ev: any): string {
  return str(ev?.tool_name) || str(ev?.name) || str(ev?.type) || str(ev?.event) || 'unrecognized';
}

// Tool steps opened but not yet finished. A step still open at the end of the
// stream never reported an outcome, so it is unknown.
class OpenSteps {
  private readonly named = new Map<string, string>();
  private readonly anon: string[] = [];
  private readonly targets = new Map<string, string>();
  private readonly anonTargets = new Map<string, string>();

  open(id: string | null, name: string, target?: string): void {
    if (id) {
      this.named.set(id, name);
      if (target) this.targets.set(id, target);
    } else if (!this.anon.includes(name)) this.anon.push(name);
    if (!id && target) this.anonTargets.set(name, target);
  }

  close(id: string | null, name: string): void {
    if (id && this.named.delete(id)) {
      this.targets.delete(id);
      return;
    }
    const i = this.anon.indexOf(name);
    if (i >= 0) this.anon.splice(i, 1);
    else if (!id) this.anon.shift();
  }

  remaining(): string[] {
    return [...this.named.values(), ...this.anon];
  }

  remainingDetailed(): { name: string; target?: string }[] {
    const out: { name: string; target?: string }[] = [];
    for (const [id, name] of this.named) out.push({ name, target: this.targets.get(id) });
    for (const name of this.anon) out.push({ name, target: this.anonTargets.get(name) });
    return out;
  }
}

function idOf(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// claude-code: Claude stream-json.

// Covers tool_use, server_tool_use, mcp_tool_use, tool_result, *_tool_result and
// any other tool-named type the CLI may add.
function isClaudeToolBlock(t: unknown): boolean {
  return typeof t === 'string' && /tool/i.test(t);
}

export function claudeParser(): EventParser {
  const out = emptyRun();
  const texts: string[] = [];
  return {
    out,
    onLine(line) {
      const ev = jsonEvent(line);
      if (!ev) return;
      if (ev.type === 'system' && ev.subtype === 'init') {
        out.initSeen = true;
        out.declaredTools = Array.isArray(ev.tools) ? ev.tools : null;
        out.mcpServers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : null;
        return;
      }
      if (isClaudeToolBlock(ev.type)) {
        out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
        return;
      }
      if ((ev.type === 'assistant' || ev.type === 'user') && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (isClaudeToolBlock(block?.type)) out.toolEvents.push({ name: labelOf(block), status: 'executed' });
          else if (ev.type === 'assistant' && block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        }
        return;
      }
      if (ev.type === 'result') {
        if (typeof ev.result === 'string') out.text = ev.result;
        out.isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
        const u = ev.usage ?? {};
        out.usage = {
          inputTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
          outputTokens: n(u.output_tokens),
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        };
        if (out.isError && typeof ev.result === 'string') out.errorHint = ev.result.slice(0, 300);
      }
    },
    finish() {
      if (!out.text) out.text = texts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// grok: streaming-json. The format has no blocked marker, so every tool event
// counts as executed (grok runs under the literal standard).

export function grokParser(): EventParser {
  const out = emptyRun();
  const texts: string[] = [];
  const setUsage = (u: any, cost: unknown): void => {
    out.usage = {
      inputTokens: n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens),
      outputTokens: n(u?.output_tokens) + n(u?.reasoning_tokens),
      costUsd: typeof cost === 'number' ? cost : out.usage.costUsd,
    };
  };
  return {
    out,
    onLine(line) {
      const ev = jsonEvent(line);
      if (!ev) return;
      switch (ev.type) {
        case 'available_commands': // commands are slash commands, not tools
          out.initSeen = true;
          if (Array.isArray(ev.tools)) out.declaredTools = [...(out.declaredTools ?? []), ...ev.tools];
          if (Array.isArray(ev.mcp_servers)) out.mcpServers = ev.mcp_servers;
          return;
        case 'text':
          if (typeof ev.data === 'string') texts.push(ev.data);
          return;
        case 'thought':
          return;
        case 'usage':
          setUsage(ev.usage, ev.usage?.total_cost_usd);
          return;
        case 'end':
          if (ev.usage) setUsage(ev.usage, ev.usage.total_cost_usd);
          if (typeof ev.stopReason === 'string' && /error|fail/i.test(ev.stopReason)) {
            out.isError = true;
            out.errorHint = errorText(ev) || `stop reason ${ev.stopReason}`;
          }
          return;
        case 'error':
          out.isError = true;
          out.errorHint = errorText(ev);
          return;
        default:
          if (looksToolish(ev)) out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
      }
    },
    finish() {
      out.text = texts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// cursor: stream-json. No tool list in init, so declaredTools stays null.
// Tool outcomes are read from the completion's result payload.

const CURSOR_BLOCK_KEYS = new Set(['permissionDenied', 'rejected', 'denied', 'blocked']);
const CURSOR_DENY_MESSAGE_RE = /permission denied|denied by|blocked by|not allowed/i;

export function classifyCursorCompletion(toolCall: any): ToolEvent {
  const keys = Object.keys(toolCall ?? {}).filter((k) => /ToolCall$/.test(k));
  if (keys.length !== 1) return { name: keys[0] ?? 'tool_call', status: 'unknown' };
  const name = keys[0];
  const args = toolCall[name]?.args;
  const target = typeof args?.targetDirectory === 'string' ? args.targetDirectory : typeof args?.path === 'string' ? args.path : undefined;
  const done = (status: ToolStatus): ToolEvent => (target ? { name, status, target } : { name, status });
  const result = toolCall[name]?.result;
  if (!result || typeof result !== 'object') return done('unknown');
  const outcomes = Object.keys(result);
  if (outcomes.length !== 1) return done('unknown');
  const outcome = outcomes[0];
  const payload = result[outcome];
  if (outcome === 'success') return done('executed');
  // Cursor reports a refused call with outcome keys like permissionDenied and
  // readPermissionDenied / writePermissionDenied (seen live 2026-10-30).
  if (CURSOR_BLOCK_KEYS.has(outcome) || outcome.endsWith('PermissionDenied')) return done('blocked');
  if (outcome === 'failure' || outcome === 'error') {
    // A command that exited non-zero did run.
    if (typeof payload?.exitCode === 'number') return done('executed');
    const msg = str(payload) || str(payload?.message) || str(payload?.errorMessage);
    if (CURSOR_DENY_MESSAGE_RE.test(msg)) return done('blocked');
  }
  return done('unknown');
}

export function cursorParser(): EventParser {
  const out = emptyRun();
  const texts: string[] = [];
  const open = new OpenSteps();
  return {
    out,
    onLine(line) {
      const ev = jsonEvent(line);
      if (!ev) return;
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            out.initSeen = true;
            if (Array.isArray(ev.tools)) out.declaredTools = ev.tools;
            if (Array.isArray(ev.mcp_servers)) out.mcpServers = ev.mcp_servers;
          } else if (looksToolish(ev)) out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
          return;
        case 'tool_call': {
          const id = idOf(ev.call_id, ev.id);
          const name = Object.keys(ev.tool_call ?? {})[0] ?? 'tool_call';
          if (ev.subtype === 'started') {
            const tc: any = (ev.tool_call as any)?.[name];
            const tgt = typeof tc?.args?.targetDirectory === 'string' ? tc.args.targetDirectory : typeof tc?.args?.path === 'string' ? tc.args.path : undefined;
            open.open(id, name, tgt);
          }
          else if (ev.subtype === 'completed') {
            open.close(id, name);
            out.toolEvents.push(classifyCursorCompletion(ev.tool_call));
          } else out.toolEvents.push({ name, status: 'unknown' });
          return;
        }
        case 'assistant':
        case 'user':
          for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
            if (block?.type === 'text') {
              if (ev.type === 'assistant' && typeof block.text === 'string') texts.push(block.text);
            } else if (looksToolish(block)) out.toolEvents.push({ name: labelOf(block), status: 'unknown' });
          }
          return;
        case 'thinking':
          return;
        case 'result': {
          if (typeof ev.result === 'string') out.text = ev.result;
          out.isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
          const u = ev.usage ?? {};
          out.usage = {
            inputTokens: n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens),
            outputTokens: n(u.outputTokens),
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          };
          if (out.isError) out.errorHint = (str(ev.result) || errorText(ev)).slice(0, 300);
          return;
        }
        case 'error':
          out.isError = true;
          out.errorHint = errorText(ev);
          return;
        default:
          if (looksToolish(ev)) out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
      }
    },
    finish() {
      for (const r of open.remainingDetailed()) out.toolEvents.push(r.target ? { name: r.name, status: 'unknown', target: r.target } : { name: r.name, status: 'unknown' });
      if (!out.text) out.text = texts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// antigravity: stream-json with an "event" discriminator. The init tool list
// is a fixed registry that never shrinks, so it proves nothing about what can
// run; the deny rules and the per-step outcomes are what count.

const AGY_DENY_MESSAGE_RE = /deny rule|denied|permission|not allowed/i;

function classifyAgyTerminal(name: string, su: any): ToolEvent | null {
  const message = str(su?.tool_info?.error?.message);
  const hasError = su?.tool_info?.error !== undefined && su?.tool_info?.error !== null;
  if (su?.state === 'DONE') return { name, status: hasError ? 'unknown' : 'executed' };
  if (su?.state === 'ERROR') return { name, status: AGY_DENY_MESSAGE_RE.test(message) ? 'blocked' : 'unknown' };
  return null;
}

export function antigravityParser(): EventParser {
  const out = emptyRun();
  const texts: string[] = [];
  const open = new OpenSteps();
  return {
    out,
    onLine(line) {
      const ev = jsonEvent(line);
      if (!ev) return;
      switch (ev.event) {
        case 'init':
          out.initSeen = true;
          out.declaredTools = Array.isArray(ev.init?.tools) ? ev.init.tools : null;
          out.mcpServers = Array.isArray(ev.init?.mcp_servers) ? ev.init.mcp_servers : null;
          out.permissionMode = typeof ev.init?.permission_mode === 'string' ? ev.init.permission_mode : null;
          return;
        case 'step_update': {
          const su = ev.step_update;
          const isTool = su?.step_type === 'tool' || typeof su?.tool_name === 'string';
          if (!isTool) {
            if (su?.step_type === 'agent_response') {
              if (typeof su.text_delta === 'string') texts.push(su.text_delta);
            } else if (su?.step_type !== 'user_input' && looksToolish(su)) {
              out.toolEvents.push({ name: labelOf(su), status: 'executed' });
            }
            return;
          }
          const name = str(su.tool_name) || 'tool';
          const id = idOf(su.step_id, su.step_index, su.id);
          const done = classifyAgyTerminal(name, su);
          if (done) {
            open.close(id, name);
            out.toolEvents.push(done);
          } else if (su.state === 'ACTIVE' || su.state === undefined) {
            open.open(id, name);
          } else {
            open.close(id, name);
            out.toolEvents.push({ name, status: 'unknown' });
          }
          return;
        }
        case 'result': {
          const r = ev.result ?? {};
          if (typeof r.response === 'string') out.text = r.response;
          if (r.status !== 'SUCCESS') {
            out.isError = true;
            out.errorHint = (errorText(r) || `result status ${str(r.status) || 'missing'}`).slice(0, 300);
          }
          const u = r.usage ?? {};
          out.usage = {
            inputTokens: n(u.input_tokens) + n(u.cache_read_tokens),
            outputTokens: n(u.output_tokens) + n(u.thinking_tokens),
          };
          return;
        }
        case 'error':
          out.isError = true;
          out.errorHint = errorText(ev);
          return;
        default:
          if (looksToolish(ev)) out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
      }
    },
    finish() {
      for (const name of open.remaining()) out.toolEvents.push({ name, status: 'unknown' });
      if (!out.text) out.text = texts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// codex: exec --json. No tool list anywhere, so declaredTools stays null.

const CODEX_TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
const CODEX_BLOCKED_ERROR_RE = /code.?mode.*(unavailable|disabled)|(tool|feature).*(disabled|unavailable)|denied|not permitted|not allowed/i;
const CODEX_DENY_MESSAGE_RE = /denied|not permitted|not allowed|disabled|unavailable/i;

function classifyCodexItem(item: any): ToolStatus {
  const status = item?.status;
  if (status === 'declined') return 'blocked';
  if (item?.type === 'web_search' && status === undefined) return 'executed';
  if (status === 'completed') return 'executed';
  if (status === 'failed') {
    // A command with an exit code did run; only the vendor's own refusal counts as blocked.
    if (typeof item.exit_code === 'number') return 'executed';
    const msg = str(item.error) || str(item.error?.message) || str(item.aggregated_output);
    if (CODEX_DENY_MESSAGE_RE.test(msg)) return 'blocked';
  }
  return 'unknown';
}

export function codexParser(): EventParser {
  const out = emptyRun();
  const texts: string[] = [];
  const open = new OpenSteps();
  return {
    out,
    onLine(line) {
      const ev = jsonEvent(line);
      if (!ev) return;
      switch (ev.type) {
        case 'thread.started':
          out.initSeen = true;
          return;
        case 'turn.started':
          return;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = ev.item;
          const t = str(item?.type);
          const completed = ev.type === 'item.completed';
          if (t === 'reasoning') return;
          if (t === 'agent_message') {
            if (completed && typeof item.text === 'string') texts.push(item.text);
            return;
          }
          if (t === 'error') {
            if (!completed) return;
            const msg = str(item.message) || str(item.error);
            // The vendor's refusal of a disabled tool arrives as an error item.
            if (CODEX_BLOCKED_ERROR_RE.test(msg)) out.toolEvents.push({ name: 'error_item', status: 'blocked' });
            else out.errorHint = msg.slice(0, 300);
            return;
          }
          // Any item type outside the known list is treated as a tool that ran.
          const name = t || 'item';
          const id = idOf(item?.id);
          if (!completed) {
            open.open(id, name);
            return;
          }
          open.close(id, name);
          out.toolEvents.push({ name, status: CODEX_TOOL_ITEMS.has(t) ? classifyCodexItem(item) : 'executed' });
          return;
        }
        case 'turn.completed': {
          const u = ev.usage ?? {};
          // input_tokens includes the cached ones; output_tokens includes reasoning.
          out.usage = {
            inputTokens: out.usage.inputTokens + n(u.input_tokens),
            outputTokens: out.usage.outputTokens + n(u.output_tokens),
          };
          return;
        }
        case 'turn.failed':
          out.isError = true;
          out.errorHint = errorText(ev);
          return;
        case 'error': // may be a retry notice; the exit code decides failure
          out.errorHint = errorText(ev);
          return;
        default:
          if (looksToolish(ev)) out.toolEvents.push({ name: labelOf(ev), status: 'executed' });
      }
    },
    finish() {
      for (const name of open.remaining()) out.toolEvents.push({ name, status: 'unknown' });
      out.text = texts.join('');
    },
  };
}

// ---------------------------------------------------------------------------
// Profiles.

const BASE_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TZ'];

// Default profile for the Claude Code CLI.
// VERIFY AGAINST YOUR INSTALLED CLI VERSION: flag and variable names change
// between releases. If any flag is wrong the CLI fails and the startup probe
// refuses to run, which is the intended failure mode.
export const CLAUDE_CODE_PROFILE: CliProfile = {
  id: 'claude-code',
  argsTemplate: [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', '{model}',
    '--max-turns', '1',
    '--tools', '', // empty allowlist: no built-in tools
    '--strict-mcp-config',
    '--mcp-config', '{mcpConfig}', // {"mcpServers":{}}
    '--settings', '{settings}', // {"disableAllHooks":true,...}
    '--disable-slash-commands',
  ],
  extraEnv: {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '{maxOutputTokens}',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  envAllowlist: BASE_ENV_ALLOWLIST,
  credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
  envDirs: [
    { name: 'CLAUDE_CONFIG_DIR', base: 'config' },
    { name: 'XDG_CONFIG_HOME', base: 'home', rel: '.config' },
  ],
  seedFiles: [
    { base: 'root', path: 'mcp.json', content: JSON.stringify({ mcpServers: {} }) },
    { base: 'root', path: 'settings.json', content: JSON.stringify({ disableAllHooks: true, enableAllProjectMcpServers: false, permissions: { allow: [] } }) },
  ],
  credentialFiles: [],
  standards: ['literal'],
  createParser: claudeParser,
  forbiddenArgs: null,
  projectConfigPaths: [],
  limitPattern: LIMIT_RE,
};

// Verified live on grok 1.0.70: this full denylist empties the declared list;
// an empty --tools allowlist does not.
export const GROK_DENIED_TOOLS = 'run_terminal_cmd,run_terminal_command,read_file,search_replace,list_dir,grep,kill_task,kill_command_or_subagent,task,spawn_subagent,todo_write,get_task_output,get_command_or_subagent_output,wait_tasks,wait_commands_or_subagents,scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,image_to_video,reference_to_video,write,web_search,web_fetch,Agent';

// Literal standard.
export const GROK_PROFILE: CliProfile = {
  id: 'grok',
  argsTemplate: [
    '--single', '{prompt}',
    '--output-format', 'streaming-json',
    '-m', '{model}',
    '--max-turns', '1',
    '--disallowed-tools', GROK_DENIED_TOOLS,
    '--disable-web-search',
    '--no-subagents',
  ],
  extraEnv: {},
  envAllowlist: BASE_ENV_ALLOWLIST,
  credentialEnv: 'XAI_API_KEY',
  envDirs: [{ name: 'XDG_CONFIG_HOME', base: 'home', rel: '.config' }],
  seedFiles: [],
  credentialFiles: [],
  standards: ['literal'],
  createParser: grokParser,
  forbiddenArgs: /^(--always-approve|--yolo|--dangerously.*)$/,
  projectConfigPaths: ['.grok'],
  limitPattern: VENDOR_LIMIT_RE,
};

// Deny patterns use both * and **: Cursor's Read/Write matching is path-glob
// based, and a bare * does not cover nested paths (a glob of the working
// directory succeeded under Read(*) alone in a live check 2026-10-30).
export const CURSOR_PERMISSIONS = { permissions: { allow: [], deny: ['Shell(*)', 'Read(*)', 'Read(**)', 'Write(*)', 'Write(**)', 'WebFetch(*)', 'Mcp(*:*)'] } };

// Blocked-execution standard only: Cursor has no tool-disable flag, its init
// event has no tool list, and the model still attempts tools in every mode.
// --trust only skips the workspace-trust prompt for the wrapper-owned directory.
// Login is the subscription auth file, seeded from the key store into the owned
// home (verified live 2026-10-30: a fresh HOME whose only credential is
// .config/cursor/auth.json reports logged in and answers). An operator who
// prefers an API key can still set credentialEnv to CURSOR_API_KEY in config.
export const CURSOR_PROFILE: CliProfile = {
  id: 'cursor',
  argsTemplate: ['-p', '--output-format', 'stream-json', '--model', '{model}', '--trust', '{prompt}'],
  extraEnv: {},
  envAllowlist: BASE_ENV_ALLOWLIST,
  credentialEnv: null, // subscription login is seeded below; config may override with CURSOR_API_KEY
  envDirs: [{ name: 'XDG_CONFIG_HOME', base: 'home', rel: '.config' }],
  // The deny config is seeded at BOTH locations Cursor reads: ~/.cursor (HOME
  // fallback) and $XDG_CONFIG_HOME/cursor (the wrapper sets XDG_CONFIG_HOME,
  // and a live trial that only had the ~/.cursor copy ran with default
  // permissions and executed tools, 2026-10-30).
  seedFiles: [
    { base: 'home', path: '.cursor/cli-config.json', content: JSON.stringify(CURSOR_PERMISSIONS), denyConfig: true },
    { base: 'home', path: '.config/cursor/cli-config.json', content: JSON.stringify(CURSOR_PERMISSIONS), denyConfig: true },
  ],
  credentialFiles: [{ source: 'cursor-auth.json', target: '.config/cursor/auth.json' }],
  discoveryTools: ['globToolCall', 'grepToolCall', 'getMcpToolsToolCall'],
  // Cursor's internal orchestration executes ungated like Antigravity's:
  // the subagent spawner (taskToolCall, extended to the AG reading by the
  // operator on 2026-10-30) and its bookkeeping tools (updateTodosToolCall
  // ~ AG's manage_task; awaitToolCall ~ AG's wait) — all internal to the
  // CLI, producing no effects of their own; subagents inherit the same
  // deny configuration. Identified from live captures 2026-10-30.
  // switchModeToolCall (the CLI's own mode switch) and interaction_query
  // (its ask-the-user tool, ~ AG's ask_question) joined the set from the
  // 2026-10-30 resident probe captures — same internal, effect-free class.
  orchestrationTools: ['taskToolCall', 'updateTodosToolCall', 'awaitToolCall', 'switchModeToolCall', 'interaction_query'],
  standards: ['blocked-execution'],
  createParser: cursorParser,
  forbiddenArgs: /^(--force|-f|--yolo|--approve-mcps|--dangerously.*)$/,
  projectConfigPaths: ['.cursor'],
  denyArgsProblem: () => null, // the deny config is the seed file above
  limitPattern: VENDOR_LIMIT_RE,
};

// action(target) deny rules. The registry tool name run_command falls under command(*).
export const ANTIGRAVITY_SETTINGS = JSON.stringify({
  toolPermission: 'request-review',
  permissions: {
    allow: [],
    deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'view_file(*)', 'list_dir(*)', 'grep_search(*)', 'find_by_name(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)', 'search_web(*)', 'browser_subagent(*)', 'generate_image(*)', 'ask_custom_permission(*)', 'ask_permission(*)', 'ask_question(*)', 'browser_click_element(*)', 'browser_drag_pixel_to_pixel(*)', 'browser_get_dom(*)', 'browser_get_network_request(*)', 'browser_input(*)', 'browser_list_network_requests(*)', 'browser_mouse_down(*)', 'browser_mouse_up(*)', 'browser_move_mouse(*)', 'browser_press_key(*)', 'browser_refresh_page(*)', 'browser_resize_window(*)', 'browser_scroll(*)', 'browser_scroll_dom(*)', 'browser_select_option(*)', 'call_mcp_tool(*)', 'capture_browser_console_logs(*)', 'capture_browser_screenshot(*)', 'click_browser_pixel(*)', 'command_status(*)', 'define_subagent(*)', 'delete_knowledge(*)', 'execute_browser_javascript(*)', 'finish(*)', 'invoke_subagent(*)', 'list_browser_pages(*)', 'list_permissions(*)', 'list_plugin_accounts(*)', 'list_resources(*)', 'manage_inbox(*)', 'manage_subagents(*)', 'manage_task(*)', 'multi_replace_file_content(*)', 'notebook_edit(*)', 'notebook_execution(*)', 'open_browser_url(*)', 'read_browser_page(*)', 'read_resource(*)', 'read_url_content(*)', 'replace_file_content(*)', 'run_command(*)', 'run_workflow(*)', 'schedule(*)', 'search_marketplace(*)', 'sed_file(*)', 'send_command_input(*)', 'send_message(*)', 'wait(*)', 'wait_5_seconds(*)', 'write_to_file(*)'],
  },
});

// Blocked-execution standard only: the init tool list is a fixed registry.
export const ANTIGRAVITY_PROFILE: CliProfile = {
  id: 'antigravity',
  argsTemplate: [
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--model', '{model}',
    '--settings', ANTIGRAVITY_SETTINGS,
    '--print={prompt}',
  ],
  extraEnv: {},
  envAllowlist: BASE_ENV_ALLOWLIST,
  credentialEnv: null,
  envDirs: [{ name: 'XDG_CONFIG_HOME', base: 'home', rel: '.config' }],
  seedFiles: [],
  credentialFiles: [{ source: 'antigravity-oauth-token', target: '.gemini/antigravity-cli/antigravity-oauth-token' }],
  standards: ['blocked-execution'],
  createParser: antigravityParser,
  forbiddenArgs: /^(--yolo|--force|--dangerously.*)$/,
  projectConfigPaths: ['.agents', '.gemini'],
  denyArgsProblem(args) {
    const i = args.indexOf('--settings');
    return i >= 0 && args[i + 1] === ANTIGRAVITY_SETTINGS ? null : 'the --settings deny rules are not the ones the wrapper defines';
  },
  expectedPermissionMode: 'request-review',
  orchestrationTools: ['invoke_subagent', 'define_subagent', 'manage_task', 'manage_subagents', 'manage_inbox', 'send_message', 'wait', 'wait_5_seconds', 'finish', 'ask_question', 'ask_permission', 'ask_custom_permission', 'list_permissions', 'list_plugin_accounts', 'command_status'],
  limitPattern: VENDOR_LIMIT_RE,
};

function disableFlags(features: string[]): string[] {
  return features.flatMap((f) => ['--disable', f]);
}

function isDisabled(args: string[], feature: string): boolean {
  return args.some((a, i) => a === '--disable' && args[i + 1] === feature);
}

const CODEX_ALWAYS_DISABLED = ['apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'hooks'];
const CODEX_BASE_ARGS = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '--model', '{model}'];

// The two variants the brief asks to compare, and the default that disables
// both execution paths so that no execution tool should remain.
export const CODEX_ARGS = {
  codeModeOff: [...CODEX_BASE_ARGS, ...disableFlags([...CODEX_ALWAYS_DISABLED, 'code_mode_host']), '-'],
  shellOff: [...CODEX_BASE_ARGS, ...disableFlags([...CODEX_ALWAYS_DISABLED, 'shell_tool', 'unified_exec']), '-'],
  allOff: [...CODEX_BASE_ARGS, ...disableFlags([...CODEX_ALWAYS_DISABLED, 'shell_tool', 'unified_exec', 'code_mode_host']), '-'],
};

// Blocked-execution standard only: no tool list exists in the format. CODEX_HOME
// is persistent so the resident's own login survives restarts; config.toml in it
// is rewritten every start and defines no MCP servers. The prompt goes over
// stdin ("-"), so this is the one non-Claude profile with no argument size limit.
export const CODEX_PROFILE: CliProfile = {
  id: 'codex',
  argsTemplate: CODEX_ARGS.allOff,
  extraEnv: {},
  envAllowlist: BASE_ENV_ALLOWLIST,
  credentialEnv: null, // set to CODEX_ACCESS_TOKEN or OPENAI_API_KEY to use the key store
  envDirs: [
    { name: 'CODEX_HOME', base: 'persist' },
    { name: 'XDG_CONFIG_HOME', base: 'home', rel: '.config' },
  ],
  seedFiles: [{ base: 'persist', path: 'config.toml', content: '# Written by the Hive wrapper on every start; edits are overwritten.\nweb_search = "disabled"\n', denyConfig: true }],
  credentialFiles: [],
  standards: ['blocked-execution'],
  createParser: codexParser,
  forbiddenArgs: /^(--yolo|--full-auto|--dangerously.*|danger-full-access|workspace-write)$/,
  projectConfigPaths: ['.codex'],
  denyArgsProblem(args) {
    if (isDisabled(args, 'code_mode_host') || (isDisabled(args, 'shell_tool') && isDisabled(args, 'unified_exec'))) return null;
    return 'neither code_mode_host nor both shell_tool and unified_exec are disabled';
  },
  limitPattern: VENDOR_LIMIT_RE,
};

export const CLI_PROFILES: Record<ProfileName, CliProfile> = {
  'claude-code': CLAUDE_CODE_PROFILE,
  grok: GROK_PROFILE,
  cursor: CURSOR_PROFILE,
  antigravity: ANTIGRAVITY_PROFILE,
  codex: CODEX_PROFILE,
};
