import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // The multi-root workspace whose folders connect to the IRIS container started from test-fixtures/client-compose
    const workspace = path.resolve(extensionDevelopmentPath, "test-fixtures", "ci.code-workspace");

    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    // Server Manager resolves the intersystems.servers entries used by the fixture workspace
    cp.spawnSync(cli, [...args, "--install-extension", "intersystems-community.servermanager"], {
      encoding: "utf-8",
      stdio: "inherit",
    });

    // A fresh user-data-dir so cached connection state from a previous run can't mask activation bugs
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-objectscript-test-"));

    const launchArgs = [
      workspace,
      "--user-data-dir",
      userDataDir,
      "--disable-workspace-trust",
      "--enable-proposed-api",
      "intersystems-community.vscode-objectscript",
    ];

    // Inherited from a VS Code extension host (e.g. a terminal spawned by an extension); would make
    // the downloaded VS Code run as plain Node and try to execute the workspace file as a script
    delete process.env.ELECTRON_RUN_AS_NODE;
    try {
      await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs });
    } catch (err) {
      // The extension's own output channel is the best record of what it sent to the server
      for (const log of fs.readdirSync(userDataDir, { recursive: true }) as string[]) {
        if (log.endsWith("ObjectScript.log")) {
          console.error(`\n===== ${log} =====\n${fs.readFileSync(path.join(userDataDir, log), "utf-8")}`);
        }
      }
      throw err;
    }
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
