import childProcess from "node:child_process";
import { Writable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Worker } from "node:worker_threads";

const originalSpawn = childProcess.spawn;
let compileCount = 0;
const solcWrapperUrl = new URL(
  "../node_modules/hardhat/dist/src/internal/builtin-plugins/solidity/build-system/compiler/solcjs-wrapper.js",
  import.meta.url,
).href;

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

(async () => {
  const { default: solcWrapper } = await import(workerData.solcWrapperUrl);
  const compilerPath = workerData.compilerUrl.startsWith("file:")
    ? fileURLToPath(workerData.compilerUrl)
    : workerData.compilerUrl;
  const compilerModule = new Module(compilerPath);
  compilerModule.filename = compilerPath;
  compilerModule.paths = Module._nodeModulePaths(path.dirname(compilerPath));
  compilerModule._compile(fs.readFileSync(compilerPath, "utf8"), compilerPath + ".cjs");
  const output = solcWrapper(compilerModule.exports).compile(workerData.input);
  parentPort.postMessage({ code: 0, stdout: output + "\n" });
})().catch((error) => {
  parentPort.postMessage({
    code: 1,
    stderr: (error && (error.stack || error.message)) ? (error.stack || error.message) + "\n" : String(error) + "\n",
  });
});
`;

function isSolcJsRunner(command, args) {
  return (
    command === process.execPath &&
    Array.isArray(args) &&
    args.some((arg) => typeof arg === "string" && arg.endsWith("solcjs-runner.js"))
  );
}

function createInProcessSolcProcess(args) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = "";

  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString("utf8");
      callback();
    },
    async final(callback) {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          compilerUrl: args.at(-1),
          input,
          solcWrapperUrl,
        },
      });
      let closed = false;
      const close = (code) => {
        if (closed) {
          return;
        }
        closed = true;
        compileCount += 1;
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", code));
        if (process.env.HARDHAT_INPROCESS_SOLC_DEBUG_HANDLES === "true") {
          setTimeout(() => {
            const handles = process._getActiveHandles?.() ?? [];
            console.error(
              `[hardhat-inprocess-solc] compiles=${compileCount} activeHandles=${handles
                .map((handle) => handle.constructor?.name ?? typeof handle)
                .join(",")}`,
            );
          }, 5000);
        }
      };
      worker.once("message", (message) => {
        if (message.stdout !== undefined) {
          stdout.write(message.stdout);
        }
        if (message.stderr !== undefined) {
          stderr.write(message.stderr);
        }
        void worker.terminate().finally(() => close(message.code));
      });
      worker.once("error", (error) => {
        stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        close(1);
      });
      worker.once("exit", (code) => {
        if (!closed && code !== 0) {
          stderr.write(`solcjs worker exited with code ${code}\n`);
          close(code ?? 1);
        }
      });
      callback();
    },
  });

  child.kill = () => {
    stdout.end();
    stderr.end();
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  return child;
}

childProcess.spawn = function patchedSpawn(command, args = [], options) {
  if (isSolcJsRunner(command, args)) {
    return createInProcessSolcProcess(args);
  }
  return originalSpawn.call(this, command, args, options);
};

syncBuiltinESMExports();
