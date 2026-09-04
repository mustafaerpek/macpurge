export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  interactive?: boolean;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: readonly string[], options?: RunOptions): Promise<CommandResult>;
  exists(command: string): Promise<boolean>;
}

export class BunCommandRunner implements CommandRunner {
  async run(command: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    if (command.length === 0) throw new Error("Cannot run an empty command");

    const proc = Bun.spawn({
      cmd: [...command],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: options.interactive ? "inherit" : "ignore",
      stdout: options.interactive ? "inherit" : "pipe",
      stderr: options.interactive ? "inherit" : "pipe",
      env: process.env,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timeout = setTimeout(() => proc.kill("SIGTERM"), options.timeoutMs);
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      options.interactive ? Promise.resolve("") : new Response(proc.stdout).text(),
      options.interactive ? Promise.resolve("") : new Response(proc.stderr).text(),
    ]);
    if (timeout) clearTimeout(timeout);

    return { exitCode, stdout, stderr };
  }

  async exists(command: string): Promise<boolean> {
    const result = await this.run(["/usr/bin/which", command]);
    return result.exitCode === 0;
  }
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly responses: Array<{
      match: (command: readonly string[]) => boolean;
      result: CommandResult;
    }> = [],
    private readonly installed: ReadonlySet<string> = new Set(),
  ) {}

  async run(command: readonly string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    return this.responses.find((entry) => entry.match(command))?.result ?? {
      exitCode: 127,
      stdout: "",
      stderr: "command not mocked",
    };
  }

  async exists(command: string): Promise<boolean> {
    // Models `which <command>`: explicit installed set wins, otherwise honor a
    // mocked `/usr/bin/which` response so fakes stay behaviorally representative.
    if (this.installed.size > 0) return this.installed.has(command);
    const which = this.responses.find((entry) => entry.match(["/usr/bin/which", command]));
    if (which) return which.result.exitCode === 0;
    return false;
  }
}
