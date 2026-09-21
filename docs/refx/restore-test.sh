#!/usr/bin/env bash
#
# Prove a backup restores. Phase 4 is not done until this has passed once.
#
# It brings up a throwaway Postgres, restores the dump into it, and then checks the thing that
# actually matters: that the stored RCON passwords decrypt under the backed-up ENCRYPTION_KEY.
# A restore that reproduces the rows but not the plaintext is a restore of an unusable panel,
# and the difference is invisible until someone tries to poll a server.
#
#   ./restore-test.sh /var/backups/refxrcon/refxrcon-20260921T031700Z.dump \
#                     /var/backups/refxrcon/refxrcon-secrets-20260921T031700Z.env
#
# Touches nothing in production: a separate container, a separate volume, a random host port,
# all removed on exit including on failure.

set -Eeuo pipefail

dump=${1:?usage: restore-test.sh <dump> <secrets.env>}
secrets=${2:?usage: restore-test.sh <dump> <secrets.env>}
[ -f "$dump" ] || { echo "no dump at $dump" >&2; exit 1; }
[ -f "$secrets" ] || { echo "no secrets at $secrets" >&2; exit 1; }

PG_IMAGE=${PG_IMAGE:-timescale/timescaledb:2.30.0-pg18}
NAME="refxrcon-restore-test-$$"
PORT=$(shuf -i 20000-29999 -n 1)
PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')

cleanup() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -f "$dump.sha256" ]; then
	echo "== checksum"
	(cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")
fi

echo "== scratch database on port $PORT"
docker run -d --name "$NAME" \
	-e POSTGRES_USER=refxrcon -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB=refxrcon \
	-p "127.0.0.1:$PORT:5432" "$PG_IMAGE" >/dev/null

for _ in $(seq 1 60); do
	docker exec "$NAME" pg_isready -U refxrcon -d refxrcon >/dev/null 2>&1 && break
	sleep 1
done
docker exec "$NAME" pg_isready -U refxrcon -d refxrcon >/dev/null || { echo "scratch database never became ready" >&2; exit 1; }

echo "== restore"
# Errors are expected and harmless on a fresh database: --clean --if-exists emits DROPs for
# objects that are not there yet. Real failures show up in the row counts below, which is why
# this does not rely on pg_restore's exit code alone.
docker exec -i "$NAME" pg_restore -U refxrcon -d refxrcon --no-owner --clean --if-exists <"$dump" 2>&1 |
	grep -viE 'does not exist|errors ignored on restore' || true

q() { docker exec -i "$NAME" psql -U refxrcon -d refxrcon -tAc "$1"; }

echo "== contents"
tables=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
servers=$(q "SELECT count(*) FROM servers")
users=$(q "SELECT count(*) FROM \"user\"")
samples=$(q "SELECT count(*) FROM samples")
printf '   tables  %s\n   servers %s\n   users   %s\n   samples %s\n' "$tables" "$servers" "$users" "$samples"

[ "$tables" -ge 25 ] || { echo "only $tables tables restored -- expected 28" >&2; exit 1; }
[ "$users" -ge 1 ] || { echo "no user rows restored: an empty panel is not a restore" >&2; exit 1; }

# --- the check that matters -------------------------------------------------------------------
# Decrypt every stored RCON password with the backed-up key. This is AES-256-GCM as
# src/lib/server/crypto.ts writes it; if the format there ever changes, this must change with it.
if [ "$servers" -gt 0 ]; then
	echo "== decrypting stored RCON passwords with the backed-up ENCRYPTION_KEY"
	# shellcheck disable=SC1090
	KEY=$(grep -E '^ENCRYPTION_KEY=' "$secrets" | cut -d= -f2-)
	[ -n "$KEY" ] || { echo "no ENCRYPTION_KEY in $secrets" >&2; exit 1; }

	q "SELECT id || ' ' || password_enc FROM servers" >"/tmp/$NAME.rows"

	KEY="$KEY" ROWS="/tmp/$NAME.rows" node -e '
	  const fs = require("fs"), crypto = require("crypto");
	  const key = Buffer.from(process.env.KEY, "base64");
	  if (key.length !== 32) { console.error("ENCRYPTION_KEY does not decode to 32 bytes"); process.exit(1); }
	  let ok = 0, bad = 0;
	  for (const line of fs.readFileSync(process.env.ROWS, "utf8").split("\n").filter(Boolean)) {
	    const sp = line.indexOf(" ");
	    const id = line.slice(0, sp), blob = line.slice(sp + 1);
	    try {
	      // src/lib/server/crypto.ts: `v1.<base64 iv>.<base64 ciphertext||tag>`,
	      // 12-byte IV, 16-byte GCM tag appended to the ciphertext.
	      const [version, ivB64, ctB64] = blob.split(".");
	      if (version !== "v1" || !ivB64 || !ctB64) throw new Error("unknown secret format");
	      const data = Buffer.from(ctB64, "base64");
	      if (data.length < 16) throw new Error("short");
	      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
	      d.setAuthTag(data.subarray(data.length - 16));
	      const out = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
	      if (out.length === 0) throw new Error("empty plaintext");
	      ok++;
	    } catch (e) { bad++; console.error("  FAILED " + id + ": " + e.message); }
	  }
	  console.log("   decrypted " + ok + " of " + (ok + bad));
	  process.exit(bad ? 1 : 0);
	' || { echo "RESTORE TEST FAILED: stored passwords do not decrypt under the backed-up key" >&2; rm -f "/tmp/$NAME.rows"; exit 1; }
	rm -f "/tmp/$NAME.rows"
else
	echo "== no servers in this backup, so there is nothing to decrypt."
	echo "   This does NOT prove the key round-trips. Re-run once at least one server exists."
fi

echo
echo "RESTORE TEST PASSED"
echo "  dump    $dump"
echo "  secrets $secrets"
