# Integration test fixtures

`npm test` opens [ci.code-workspace](ci.code-workspace) in a downloaded VS Code and runs the suite in
`src/test/suite` against an IRIS container. Every workspace folder connects to that one container by a
different mechanism:

| Folder                 | Mechanism                                                    |
| ---------------------- | ------------------------------------------------------------ |
| `client-hostport`      | `objectscript.conn` with host/port/credentials               |
| `client-compose`       | `objectscript.conn.docker-compose` port resolution           |
| `client-named-server`  | `objectscript.conn.server` naming an `intersystems.servers` entry with a plaintext password |
| `client-inactive`      | `"active": false`, pointing at an unreachable host           |
| `server-side`          | `isfs://ci:user/`                                            |

The container ([client-compose/docker-compose.yml](client-compose/docker-compose.yml)) publishes fixed host ports and runs
[client-compose/setup/setup.sh](client-compose/setup/setup.sh) after IRIS starts, which sets a 10-second `/api/atelier`
session timeout so expired-session recovery can be tested.

In CI this runs from `.github/workflows/prepare-release.yml`, on PRs whose source branch starts with
`prepare-` and on manual dispatch. To run locally, with either Docker or Podman:

```sh
podman compose -f test-fixtures/client-compose/docker-compose.yml up -d --wait   # or: docker compose ...
npm test
podman compose -f test-fixtures/client-compose/docker-compose.yml down -v
```
