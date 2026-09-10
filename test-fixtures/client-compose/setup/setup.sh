#!/bin/sh
# Runs inside the container after IRIS starts (see docker-compose.yml).
# Configures the instance for the integration tests, then drops a marker file the healthcheck waits for.
set -e

iris session IRIS -U %SYS <<'EOF'
// Predefined accounts keep their default password (SYS) but must not demand a change on first login
Write "UnExpire: ",##class(Security.Users).UnExpireUserPasswords("*"),!
// Short Atelier session timeout so the tests can exercise expired-session recovery
Do ##class(Security.Applications).Get("/api/atelier",.a)
Set a("Timeout")=10
Write "Timeout: ",##class(Security.Applications).Modify("/api/atelier",.a),!
Halt
EOF

touch /tmp/ci-setup-done
