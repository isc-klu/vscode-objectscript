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

    // The path to the workspace file
    const workspace = path.resolve("test-fixtures", "test.code-workspace");

    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    const installExtension = (extId) =>
      cp.spawnSync(cli, [...args, "--install-extension", extId], {
        encoding: "utf-8",
        stdio: "inherit",
      });

    // Install dependent extensions
    installExtension("intersystems-community.servermanager");
    installExtension("intersystems.language-server");

    // A fresh user-data-dir so state cached by a previous run can't affect this one
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
    // Download VS Code, unzip it and run the integration test
    await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs });
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
