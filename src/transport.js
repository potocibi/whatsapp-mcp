// Outbound transport: hand the message to an external command.
//
// This server has no WhatsApp session of its own, and deliberately so - holding one would
// make it the single owner of the account's login and put it in contention with whatever
// pipeline already does the sending. Instead it shells out to a command you nominate, which
// might be your own sender script, a Cloud API curl, or anything else.
//
// The recipient and text are passed as ENVIRONMENT VARIABLES by default (WA_TO / WA_MSG),
// never interpolated into a shell string. A message body containing quotes, newlines,
// backticks or a stray `; rm -rf` is therefore inert - it is data handed to a process, not
// text pasted into a command line.

import { spawn } from 'node:child_process';

/**
 * @param {object} cfg
 * @param {string}   cfg.command      executable to run
 * @param {string[]} [cfg.args]       arguments; the tokens {to} and {text} are substituted
 * @param {number}   [cfg.timeoutMs]  kill the process after this long
 * @param {object}   [cfg.env]        extra environment for the child
 * @returns {(to: string, text: string) => Promise<object>}
 */
export function commandTransport({ command, args = [], timeoutMs = 120_000, env = {} } = {}) {
  if (!command) throw new Error('commandTransport needs a command');
  return (to, text) => new Promise((resolve, reject) => {
    // Substitution is for callers whose sender wants positional arguments. Values go in as
    // discrete argv entries, so no quoting or escaping is involved at any point.
    const argv = args.map((a) => a.replace('{to}', to).replace('{text}', text));
    const child = spawn(command, argv, {
      env: { ...process.env, ...env, WA_TO: to, WA_MSG: text },
      shell: false,                        // never a shell: argv stays argv
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    child.stdout.on('data', (d) => { out += d; if (out.length > 8000) out = out.slice(-8000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`send command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      finish(reject, new Error(`could not run send command: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish(resolve, { exit_code: 0, stdout: out.trim().slice(0, 2000) });
      } else {
        // Surface the command's own complaint - it knows why it failed, this layer does not.
        finish(reject, new Error(
          `send command exited ${code}: ${(err.trim() || out.trim() || '(no output)').slice(0, 500)}`
        ));
      }
    });
  });
}
