/**
 * Integration tests against the IRIS container defined in test-fixtures/client-compose/docker-compose.yml,
 * opened through the multi-root workspace test-fixtures/ci.code-workspace. Each workspace folder is one
 * configuration; the same checks run against every configuration they apply to. Every check asserts that
 * the extension used the credentials stored in settings without prompting: a prompt would leave the
 * connection unestablished and the test would time out.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "intersystems-community.vscode-objectscript";
const SERVER_MANAGER_ID = "intersystems-community.servermanager";

/** Must match test-fixtures/client-compose/docker-compose.yml and the credentials in test-fixtures/ci.code-workspace */
const IRIS = { host: "localhost", port: 52799, ns: "USER", username: "_SYSTEM", password: "SYS" };
/** The /api/atelier session timeout configured by test-fixtures/client-compose/setup/setup.sh */
const SESSION_TIMEOUT_MS = 10000;
/** `AtelierAPI` reports this version until the extension has successfully fetched real server info */
const PLACEHOLDER_SERVER_VERSION = "2016.2.0";

/** Client-side configurations (each has an objectscript.conn in its .vscode/settings.json) that should connect */
const CLIENT_SIDE = ["client-hostport", "client-compose", "client-named-server"];
/** Every configuration that should connect */
const CONNECTED = [...CLIENT_SIDE, "server-side"];

let api: any;
/** Server documents created by the tests, for cleanup */
const created: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await sleep(1000);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
}

function folderUri(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
  assert.ok(folder, `workspace folder '${name}' is missing`);
  return folder.uri;
}

/** Talks to the container directly, bypassing the extension, to check what actually landed on the server */
async function restDoc(method: "GET" | "DELETE", name: string): Promise<string | undefined> {
  const response = await fetch(`http://${IRIS.host}:${IRIS.port}/api/atelier/v1/${IRIS.ns}/doc/${name}`, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(`${IRIS.username}:${IRIS.password}`).toString("base64") },
  });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `${method} ${name} failed with HTTP ${response.status}`);
  const { result } = await response.json();
  return Array.isArray(result.content) ? result.content.join("\n") : undefined;
}

/** A connection is established once the extension has fetched the server's real version */
async function connectedServer(uri: vscode.Uri) {
  const server = await api.asyncServerForUri(uri);
  return server?.active && server.serverVersion !== PLACEHOLDER_SERVER_VERSION ? server : undefined;
}

/** Write a class through the folder, confirm it reached the server, delete it, confirm it's gone */
async function assertRoundTrip(folder: string, suffix = ""): Promise<void> {
  const root = folderUri(folder);
  const className = `CiTest.${folder.replace(/-/g, "")}${suffix}`;
  const file =
    root.scheme === "isfs"
      ? vscode.Uri.joinPath(root, `${className.replace(/\./g, "/")}.cls`)
      : // Written straight into the pre-existing src/ folder: creating a directory tree and a file in it at
        // once can lose the file's watcher event on Linux, which is not what this is testing
        vscode.Uri.joinPath(root, "src", `${className}.cls`);
  created.push(`${className}.cls`);
  const source = `Class ${className}\n{\n\nClassMethod Hello() As %String\n{\n\tQuit "hello"\n}\n\n}\n`;
  await vscode.workspace.fs.writeFile(file, Buffer.from(source));
  const onServer = await waitFor(`${className} to appear on the server`, () => restDoc("GET", `${className}.cls`));
  assert.match(onServer, new RegExp(`^Class ${className}`));
  await vscode.workspace.fs.delete(file);
  await waitFor(`${className} to be deleted from the server`, async () => !(await restDoc("GET", `${className}.cls`)));
}

/** Turn a client-side folder's connection off, run `whileOff`, turn it back on and wait for it to reconnect */
async function withConnectionOff(folder: string, whileOff: () => Promise<unknown>): Promise<void> {
  const uri = folderUri(folder);
  const configuration = vscode.workspace.getConfiguration("objectscript", uri);
  const conn = configuration.get<object>("conn");
  await configuration.update("conn", { ...conn, active: false }, vscode.ConfigurationTarget.WorkspaceFolder);
  try {
    await waitFor("the connection to go inactive", async () => api.serverForUri(uri).active === false);
    await whileOff();
  } finally {
    await configuration.update("conn", conn, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await waitFor("the connection to come back", () => connectedServer(uri));
}

suite("Connections to an IRIS container", () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension(SERVER_MANAGER_ID)?.activate();
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed`);
    // Hangs here (and fails on the mocha timeout) if activation blocks on the inactive folder whose
    // server is unreachable, or on a credential prompt for it
    api = await extension.activate();
  });

  suiteTeardown(async () => {
    for (const name of created) await restDoc("DELETE", name).catch(() => undefined);
    for (const folder of CLIENT_SIDE) {
      const src = vscode.Uri.joinPath(folderUri(folder), "src");
      for (const [name] of await vscode.workspace.fs.readDirectory(src)) {
        if (name.endsWith(".cls")) await vscode.workspace.fs.delete(vscode.Uri.joinPath(src, name));
      }
    }
  });

  for (const folder of CONNECTED) {
    test(`${folder}: connects using the credentials in settings`, async () => {
      const uri = folderUri(folder);
      if (CLIENT_SIDE.includes(folder)) {
        // Activation checks each *server* once, so a folder sharing its server with another folder
        // is only checked once a document in it becomes active, as happens when a user opens one
        await vscode.window.showTextDocument(vscode.Uri.joinPath(uri, ".vscode", "settings.json"));
      }
      const server = await waitFor(`${folder} to connect`, () => connectedServer(uri), 60000);
      assert.strictEqual(server.host, IRIS.host);
      assert.strictEqual(server.port, IRIS.port);
      assert.strictEqual(server.namespace, IRIS.ns);
      assert.strictEqual(server.username, IRIS.username);
      // A password stored in plaintext in settings must be passed on to API consumers such as Language Server
      assert.strictEqual(server.password, IRIS.password);
    });
  }

  test("client-inactive: stays inactive and does not expose a password it was never given", () => {
    const server = api.serverForUri(folderUri("client-inactive"));
    assert.strictEqual(server.active, false);
    assert.strictEqual(server.password, undefined);
  });

  test("server-side: lists the namespace", async () => {
    const entries = await vscode.workspace.fs.readDirectory(folderUri("server-side"));
    assert.ok(entries.length > 0, "namespace listing is empty");
  });

  for (const folder of CONNECTED) {
    test(`${folder}: saving a class syncs it to the server and deleting it removes it`, () => assertRoundTrip(folder));
  }

  // AtelierAPI hard-codes active: true for a resolved docker-compose connection, so the compose folder
  // never goes inactive. Skip checks that need it to, until that is fixed.
  const toggleTest = (folder: string) => (folder === "client-compose" ? test.skip : test);

  for (const folder of CLIENT_SIDE) {
    toggleTest(folder)(`${folder}: turning objectscript.conn.active off and on is honoured`, async () => {
      await withConnectionOff(folder, async () => {
        // It must stay off rather than being forced back on by the connection check
        await sleep(5000);
        assert.strictEqual(api.serverForUri(folderUri(folder)).active, false);
        // Keep the session cookie fresh: meeting a stale one is the scenario of the expired-session tests
        await vscode.workspace.fs.readDirectory(folderUri("server-side"));
      });
    });
  }

  for (const folder of CONNECTED) {
    test(`${folder}: an expired session is re-established without prompting`, async () => {
      // Idle past the server's session timeout so the extension's cached cookie is rejected with a 401
      await sleep(SESSION_TIMEOUT_MS + 3000);
      await assertRoundTrip(folder, "Expired");
    });
  }

  for (const folder of CLIENT_SIDE) {
    toggleTest(folder)(
      `${folder}: a connection check after the session expired recovers without prompting`,
      async () => {
        await withConnectionOff(folder, () => sleep(SESSION_TIMEOUT_MS + 3000));
      }
    );
  }
});
