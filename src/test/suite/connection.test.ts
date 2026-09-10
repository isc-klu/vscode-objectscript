/**
 * Integration tests against the IRIS container defined in test-fixtures/iris/docker-compose.yml,
 * opened through the multi-root workspace test-fixtures/ci.code-workspace. Each folder connects
 * to that same container by a different mechanism, and every test asserts that the extension
 * used the credentials stored in settings without prompting: a prompt would leave the connection
 * unestablished and the test would time out.
 */
import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "intersystems-community.vscode-objectscript";
const SERVER_MANAGER_ID = "intersystems-community.servermanager";

/** Must match test-fixtures/iris/docker-compose.yml and the credentials in test-fixtures/ci.code-workspace */
const IRIS = { host: "localhost", port: 52799, ns: "USER", username: "_SYSTEM", password: "SYS" };
/** The /api/atelier session timeout configured by test-fixtures/iris/setup/setup.sh */
const SESSION_TIMEOUT_MS = 10000;
/** `AtelierAPI` reports this version until the extension has successfully fetched real server info */
const PLACEHOLDER_SERVER_VERSION = "2016.2.0";

/** Workspace folders that should be connected, keyed by the mechanism they use to find the server */
const CONNECTED_FOLDERS = {
  "client-conn": "host/port in objectscript.conn",
  iris: "docker-compose port resolution",
  "client-named": "intersystems.servers entry",
};

let api: any;

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

function classSource(name: string): Uint8Array {
  return Buffer.from(`Class ${name}\n{\n\nClassMethod Hello() As %String\n{\n\tQuit "hello"\n}\n\n}\n`);
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

async function assertSyncsToServer(folder: string, className: string): Promise<void> {
  // Written straight into the pre-existing src/ folder: creating a directory tree and a file in it at
  // once can lose the file's watcher event on Linux, which is not what this is testing
  const local = vscode.Uri.joinPath(folderUri(folder), "src", `${className}.cls`);
  await vscode.workspace.fs.writeFile(local, classSource(className));
  const onServer = await waitFor(`${className} to appear on the server`, () => restDoc("GET", `${className}.cls`));
  assert.match(onServer, new RegExp(`^Class ${className}`));
  await vscode.workspace.fs.delete(local);
  await waitFor(`${className} to be deleted from the server`, async () => !(await restDoc("GET", `${className}.cls`)));
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
    await restDoc("DELETE", "CiTest.Isfs.cls").catch(() => undefined);
    for (const folder of Object.keys(CONNECTED_FOLDERS)) {
      const src = vscode.Uri.joinPath(folderUri(folder), "src");
      for (const [name] of await vscode.workspace.fs.readDirectory(src)) {
        if (name.endsWith(".cls")) await vscode.workspace.fs.delete(vscode.Uri.joinPath(src, name));
      }
    }
  });

  for (const [folder, mechanism] of Object.entries(CONNECTED_FOLDERS)) {
    test(`${folder}: connects via ${mechanism} using the credentials in settings`, async () => {
      const uri = folderUri(folder);
      // Activation checks each *server* once, so a folder sharing its server with another folder
      // is only checked once a document in it becomes active, as happens when a user opens one
      await vscode.window.showTextDocument(vscode.Uri.joinPath(uri, ".vscode", "settings.json"));
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

  test("server-side: lists the namespace and writes a new class through isfs", async () => {
    const root = folderUri("server-side");
    const entries = await vscode.workspace.fs.readDirectory(root);
    assert.ok(entries.length > 0, "namespace listing is empty");
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, "CiTest", "Isfs.cls"), classSource("CiTest.Isfs"));
    const onServer = await waitFor("CiTest.Isfs to appear on the server", () => restDoc("GET", "CiTest.Isfs.cls"));
    assert.match(onServer, /^Class CiTest\.Isfs/);
  });

  for (const folder of Object.keys(CONNECTED_FOLDERS)) {
    test(`${folder}: saving a class under src/ syncs it to the server and deleting it removes it`, async () => {
      await assertSyncsToServer(folder, `CiTest.${folder.replace(/-/g, "")}`);
    });
  }

  test("an expired session is re-established without prompting", async () => {
    // Idle past the server's session timeout so the extension's cached cookies are rejected with a 401
    await sleep(SESSION_TIMEOUT_MS + 3000);
    const entries = await vscode.workspace.fs.readDirectory(folderUri("server-side"));
    assert.ok(entries.length > 0, "namespace listing is empty after session expiry");
    await assertSyncsToServer("client-conn", "CiTest.AfterExpiry");
  });

  test("client-conn: turning objectscript.conn.active off and on is honoured", async () => {
    const uri = folderUri("client-conn");
    await withConnectionOff(uri, async () => {
      // It must stay off rather than being forced back on by the connection check
      await sleep(5000);
      assert.strictEqual(api.serverForUri(uri).active, false);
      // Keep the session cookie fresh: meeting a stale one is the scenario of the next test
      await vscode.workspace.fs.readDirectory(folderUri("server-side"));
    });
  });

  // A connection check that meets an expired session should recover by itself, but currently prompts
  // for a password and never settles (#1861). Un-skip when #1864 lands.
  test.skip("client-conn: a connection check after the session expired recovers without prompting", async () => {
    await withConnectionOff(folderUri("client-conn"), () => sleep(SESSION_TIMEOUT_MS + 3000));
  });
});

/** Turn the folder's connection off, run `whileOff`, turn it back on and wait for it to reconnect */
async function withConnectionOff(uri: vscode.Uri, whileOff: () => Promise<unknown>): Promise<void> {
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
