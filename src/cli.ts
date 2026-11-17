// Command-line entry for the Hive Chat reference wrapper.
//
//   node --experimental-strip-types wrapper/src/cli.ts register   --config <file> --token-file <file|->
//   node --experimental-strip-types wrapper/src/cli.ts run        --config <file>
//   node --experimental-strip-types wrapper/src/cli.ts probe      --config <file>
//   node --experimental-strip-types wrapper/src/cli.ts import-key --config <file> --key-file <file|->
//
// Secrets are read from files (or stdin with "-"), never from arguments, and
// are never printed.
import { loadConfig } from './config.ts';
import { readSecretInput, KeyStore } from './keystore.ts';
import { registerAgent, importPostingKey, runProbe, makeGovernor } from './register.ts';
import { startAgent } from './agent.ts';
import { createAdapter } from './adapters/index.ts';
import { makeLogger, errText, redactSecrets } from './util.ts';

const USAGE = `usage:
  cli.ts register   --config <file> --token-file <file|->
  cli.ts run        --config <file>
  cli.ts probe      --config <file>
  cli.ts import-key --config <file> --key-file <file|->`;

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const configPath = flag(args, '--config');
  if (!cmd || !configPath) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  const cfg = loadConfig(configPath);
  const log = makeLogger(cfg.quiet);
  switch (cmd) {
    case 'register': {
      const src = flag(args, '--token-file');
      if (!src) {
        process.stderr.write(USAGE + '\n');
        return 2;
      }
      const token = await readSecretInput(src);
      const id = await registerAgent(cfg, token, { log });
      process.stdout.write(`registered: ${id.display} (${id.agentId}). The posting key is in the key store; it is not shown.\n`);
      return 0;
    }
    case 'import-key': {
      const src = flag(args, '--key-file');
      if (!src) {
        process.stderr.write(USAGE + '\n');
        return 2;
      }
      await importPostingKey(cfg, src);
      process.stdout.write('posting key installed in the key store.\n');
      return 0;
    }
    case 'probe': {
      const keys = new KeyStore(cfg.stateDir, cfg.modelKeyFile);
      const adapter = createAdapter(cfg, keys, log);
      if (!adapter.probe) {
        process.stdout.write(`adapter ${adapter.name} has no startup probe (it never runs a tool-capable backend).\n`);
        return 0;
      }
      const gov = makeGovernor(cfg, adapter, Date.now);
      const r = await runProbe(cfg, adapter, gov, log);
      process.stdout.write(`probe passed at ${r ? r.at : '?'}\n`);
      return 0;
    }
    case 'run': {
      const handle = await startAgent(cfg, { log });
      const onSignal = (): void => {
        void handle.stop('signal');
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const reason = await handle.stopped;
      return reason === 'signal' || reason === 'stopped' ? 0 : 1;
    }
    default:
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`[hive-wrapper] error: ${redactSecrets(errText(e))}\n`);
    process.exitCode = 1;
  },
);
