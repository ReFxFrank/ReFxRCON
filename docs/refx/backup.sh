#!/usr/bin/env bash
#
# Nightly backup for ReFxRCON.
#
# A database dump on its own is NOT a backup of this system. Every stored RCON password is
# AES-256-GCM encrypted under ENCRYPTION_KEY, which lives in .env and not in Postgres. Restore
# the dump without that key and the panel answers
#
#     Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?
#
# and every server has to be re-added by hand. This script therefore writes two artefacts and
# refuses to write only one.
#
#   ./backup.sh                       # writes into $BACKUP_DIR (default /var/backups/refxrcon)
#   BACKUP_DIR=/mnt/off-box ./backup.sh
#
# Install as a nightly job (03:17 rather than 03:00 so it does not contend with everything else
# on the host that runs at the top of the hour):
#
#   17 3 * * * /opt/refxrcon/docs/refx/backup.sh >>/var/log/refxrcon-backup.log 2>&1
#
# Verify it with restore-test.sh. A backup that has never been restored is a hypothesis.

set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/refxrcon}
COMPOSE_FILE=${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}
DB_SERVICE=${DB_SERVICE:-db}
DB_USER=${DB_USER:-refxrcon}
DB_NAME=${DB_NAME:-refxrcon}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/refxrcon}
KEEP_DAYS=${KEEP_DAYS:-30}
ENV_FILE=${ENV_FILE:-$APP_DIR/.env}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$BACKUP_DIR/refxrcon-$stamp.dump"
secrets="$BACKUP_DIR/refxrcon-secrets-$stamp.env"

die() {
	echo "backup: $*" >&2
	exit 1
}

command -v docker >/dev/null || die "docker not found"
[ -f "$COMPOSE_FILE" ] || die "no compose file at $COMPOSE_FILE (set COMPOSE_FILE)"
[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE (set ENV_FILE)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# --- the secrets, first ----------------------------------------------------------------------
# Written before the dump on purpose. If the disk is full or the directory is unwritable, fail
# here rather than after producing a dump that cannot be decrypted -- a dump with no key beside
# it is worse than no dump, because it looks like a backup.
umask 077
{
	echo "# ReFxRCON secrets, $stamp"
	echo "# Restoring the dump beside this file without these values leaves every stored RCON"
	echo "# password undecryptable. Keep this file somewhere the database dump is not."
	grep -E '^(ENCRYPTION_KEY|BETTER_AUTH_SECRET|POSTGRES_PASSWORD)=' "$ENV_FILE"
} >"$secrets"

grep -q '^ENCRYPTION_KEY=' "$secrets" || die "ENCRYPTION_KEY not found in $ENV_FILE -- refusing to write a dump that could not be restored"

# --- the dump --------------------------------------------------------------------------------
# Custom format (-Fc): compressed, and pg_restore can then be selective and parallel.
# --clean --if-exists so a restore over a populated database is idempotent.
docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
	pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --clean --if-exists >"$dump" ||
	die "pg_dump failed"

# An empty or truncated dump is the failure this catches: pg_dump can exit 0 and still produce
# nothing useful if the container died mid-stream.
size=$(stat -c %s "$dump")
[ "$size" -gt 20000 ] || die "dump is only ${size} bytes -- treating as failed"

sha256sum "$dump" >"$dump.sha256"

# --- prune -----------------------------------------------------------------------------------
find "$BACKUP_DIR" -name 'refxrcon-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'refxrcon-*.dump.sha256' -mtime "+$KEEP_DAYS" -delete
# Secrets are kept longer and pruned by hand. They are tiny, they change almost never, and the
# one you need is usually older than the dump you are restoring.

echo "backup: $dump ($(numfmt --to=iec "$size"))"
echo "backup: $secrets"
echo "backup: copy BOTH off this machine. A dump without the key restores to nothing usable."
