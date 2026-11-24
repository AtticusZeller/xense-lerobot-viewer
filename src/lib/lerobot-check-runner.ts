import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pythonSpawnEnv } from "@/lib/python-runtime";

const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 32_000;

export type CalibrationCliAction = "calib-frames" | "calibrate";
export type LerobotCheckCliAction =
  | CalibrationCliAction
  | "distribution"
  | "suggest";

export interface CalibrationCliInvocation {
  configured: boolean;
  projectDir: string | null;
  bin: string;
  args: string[];
  displayCommand: string;
}

export interface CliExecResult {
  ok: boolean;
  configured: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Per-dataset+scope lock so overlapping runs cannot race on `.xense-viewer/` files. */
const activeRuns = new Map<string, { action: string; startedAt: number }>();

function runLockKey(
  datasetDir: string,
  scope: "calib" | "distribution" | "suggest",
): string {
  return `${datasetDir}::${scope}`;
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

export function resolveLerobotCheckDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.LEROBOT_CHECK_DIR?.trim();
  return raw ? raw : null;
}

export function buildCalibrationCliInvocation(
  action: LerobotCheckCliAction,
  options: {
    datasetDir: string;
    repoId: string;
    append?: number;
    count?: number;
    testPerTier?: number;
    seed?: number;
    env?: Record<string, string | undefined>;
  },
): CalibrationCliInvocation {
  const projectDir = resolveLerobotCheckDir(options.env);
  const subcommandArgs: string[] = [
    action,
    "--dataset-root",
    options.datasetDir,
    "--repo-id",
    options.repoId,
  ];
  if (
    action === "calib-frames" &&
    typeof options.append === "number" &&
    Number.isInteger(options.append) &&
    options.append > 0
  ) {
    subcommandArgs.push("--append", String(options.append));
  }
  if (action === "suggest") {
    if (
      typeof options.count === "number" &&
      Number.isInteger(options.count) &&
      options.count > 0
    ) {
      subcommandArgs.push("-n", String(options.count));
    }
    if (
      typeof options.testPerTier === "number" &&
      Number.isInteger(options.testPerTier) &&
      options.testPerTier >= 0
    ) {
      subcommandArgs.push("--test-per-tier", String(options.testPerTier));
    }
    if (typeof options.seed === "number" && Number.isInteger(options.seed)) {
      subcommandArgs.push("--seed", String(options.seed));
    }
  }

  if (projectDir) {
    const args = [
      "run",
      "--project",
      projectDir,
      "lerobot-check",
      ...subcommandArgs,
    ];
    return {
      configured: true,
      projectDir,
      bin: "uv",
      args,
      displayCommand: ["uv", ...args.map(shellQuote)].join(" "),
    };
  }

  return {
    configured: false,
    projectDir: null,
    bin: "lerobot-check",
    args: subcommandArgs,
    displayCommand: ["lerobot-check", ...subcommandArgs.map(shellQuote)].join(
      " ",
    ),
  };
}

export function buildCalibrationCommands(
  datasetDir: string,
  repoId: string,
  env: Record<string, string | undefined> = process.env,
): {
  configured: boolean;
  projectDir: string | null;
  commands: {
    initFrames: string;
    appendFrames: string;
    calibrate: string;
  };
} {
  const initFrames = buildCalibrationCliInvocation("calib-frames", {
    datasetDir,
    repoId,
    env,
  });
  const appendFrames = buildCalibrationCliInvocation("calib-frames", {
    datasetDir,
    repoId,
    append: 5,
    env,
  });
  const calibrate = buildCalibrationCliInvocation("calibrate", {
    datasetDir,
    repoId,
    env,
  });

  return {
    configured: initFrames.configured,
    projectDir: initFrames.projectDir,
    commands: {
      initFrames: initFrames.displayCommand,
      appendFrames: appendFrames.displayCommand,
      calibrate: calibrate.displayCommand,
    },
  };
}

export function buildDistributionCommand(
  datasetDir: string,
  repoId: string,
  env: Record<string, string | undefined> = process.env,
): {
  configured: boolean;
  projectDir: string | null;
  command: string;
} {
  const invocation = buildCalibrationCliInvocation("distribution", {
    datasetDir,
    repoId,
    env,
  });
  return {
    configured: invocation.configured,
    projectDir: invocation.projectDir,
    command: invocation.displayCommand,
  };
}

export function buildSuggestCommand(
  datasetDir: string,
  repoId: string,
  options: {
    count?: number;
    testPerTier?: number;
    seed?: number;
    env?: Record<string, string | undefined>;
  } = {},
): {
  configured: boolean;
  projectDir: string | null;
  command: string;
} {
  const invocation = buildCalibrationCliInvocation("suggest", {
    datasetDir,
    repoId,
    count: options.count,
    testPerTier: options.testPerTier,
    seed: options.seed,
    env: options.env,
  });
  return {
    configured: invocation.configured,
    projectDir: invocation.projectDir,
    command: invocation.displayCommand,
  };
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + chunk).slice(0, MAX_OUTPUT_CHARS);
}

export function getActiveCalibrationRun(
  datasetDir: string,
): { action: string; startedAt: number } | null {
  return activeRuns.get(runLockKey(datasetDir, "calib")) ?? null;
}

export function getActiveDistributionRun(
  datasetDir: string,
): { action: string; startedAt: number } | null {
  return activeRuns.get(runLockKey(datasetDir, "distribution")) ?? null;
}

export function getActiveSuggestRun(
  datasetDir: string,
): { action: string; startedAt: number } | null {
  return activeRuns.get(runLockKey(datasetDir, "suggest")) ?? null;
}

async function runLerobotCheckCli(
  action: LerobotCheckCliAction,
  scope: "calib" | "distribution" | "suggest",
  options: {
    datasetDir: string;
    repoId: string;
    append?: number;
    count?: number;
    testPerTier?: number;
    seed?: number;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<CliExecResult> {
  const invocation = buildCalibrationCliInvocation(action, options);
  if (!invocation.configured) {
    return {
      ok: false,
      configured: false,
      command: invocation.displayCommand,
      exitCode: null,
      stdout: "",
      stderr: "",
      error:
        "LEROBOT_CHECK_DIR is not set. Set LEROBOT_CHECK_DIR in the viewer environment or run the command manually.",
    };
  }

  const lockKey = runLockKey(options.datasetDir, scope);
  if (activeRuns.has(lockKey)) {
    const running = activeRuns.get(lockKey)!;
    return {
      ok: false,
      configured: true,
      command: invocation.displayCommand,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: `A lerobot-check ${running.action} command is already running for this dataset.`,
    };
  }

  activeRuns.set(lockKey, { action, startedAt: Date.now() });
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;

  try {
    return await new Promise<CliExecResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.bin, invocation.args, {
          cwd: invocation.projectDir ?? process.cwd(),
          env: pythonSpawnEnv(options.env ?? process.env),
        });
      } catch (err) {
        resolve({
          ok: false,
          configured: true,
          command: invocation.displayCommand,
          exitCode: null,
          stdout: "",
          stderr: "",
          error: `Failed to spawn ${invocation.bin}: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: CliExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          configured: true,
          command: invocation.displayCommand,
          exitCode: null,
          stdout,
          stderr,
          error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout = appendCapped(stdout, chunk.toString());
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendCapped(stderr, chunk.toString());
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          configured: true,
          command: invocation.displayCommand,
          exitCode: null,
          stdout,
          stderr,
          error: `Failed to execute ${invocation.bin}: ${err.message}`,
        });
      });
      child.on("close", (code) => {
        const ok = code === 0;
        const lastStderrLine = stderr.trim().split(/\r?\n/).pop();
        finish({
          ok,
          configured: true,
          command: invocation.displayCommand,
          exitCode: code,
          stdout,
          stderr,
          error: ok
            ? null
            : lastStderrLine ||
              `lerobot-check ${action} exited with code ${code ?? "unknown"}.`,
        });
      });
    });
  } finally {
    activeRuns.delete(lockKey);
  }
}

export function runCalibrationCli(
  action: CalibrationCliAction,
  options: {
    datasetDir: string;
    repoId: string;
    append?: number;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<CliExecResult> {
  return runLerobotCheckCli(action, "calib", options);
}

export function runDistributionCli(options: {
  datasetDir: string;
  repoId: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<CliExecResult> {
  return runLerobotCheckCli("distribution", "distribution", options);
}

export function runSuggestCli(options: {
  datasetDir: string;
  repoId: string;
  count?: number;
  testPerTier?: number;
  seed?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<CliExecResult> {
  return runLerobotCheckCli("suggest", "suggest", options);
}
