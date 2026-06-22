#!/bin/bash
# ==========================================
# VULMINI — Restore Script
# ==========================================
# Emergency recovery from backup.
# Triggered by Gemini via MCP on update failure on production.
#
# Usage:
#   ./restore.sh <backup_id>         - full recovery (DB + plugins)
#   ./restore.sh <backup_id> db      - DB only
#   ./restore.sh <backup_id> plugins - plugins only

set -euo pipefail

BACKUP_DIR="/var/www/html/wp-content/backups"
BACKUP_ID="${1:-}"

if [ -z "$BACKUP_ID" ]; then
    echo "[Vulmini Restore] ❌ Error: backup_id required"
    echo "Usage: $0 <backup_id> [full|db|plugins]"
    echo ""
    echo "Available backups:"
    ls -la "$BACKUP_DIR"/ 2>/dev/null || echo "  No backups found"
    exit 1
fi

SCOPE="${2:-full}"

restore_db() {
    local DUMP_FILE="$BACKUP_DIR/db_${BACKUP_ID}.sql.gz"
    if [ ! -f "$DUMP_FILE" ]; then
        echo "[Vulmini Restore] ❌ DB dump not found: $DUMP_FILE"
        return 1
    fi
    echo "[Vulmini Restore] Importing database from $DUMP_FILE..."
    gunzip -c "$DUMP_FILE" | wp db import - --allow-root
    echo "[Vulmini Restore] ✅ Database restored"
}

restore_plugins() {
    local ARCHIVE="$BACKUP_DIR/plugins_${BACKUP_ID}.tar.gz"
    if [ ! -f "$ARCHIVE" ]; then
        echo "[Vulmini Restore] ❌ Plugin archive not found: $ARCHIVE"
        return 1
    fi
    echo "[Vulmini Restore] Extracting plugins from $ARCHIVE..."
    tar -xzf "$ARCHIVE" -C /var/www/html/wp-content/
    echo "[Vulmini Restore] ✅ Plugins restored"
}

flush_caches() {
    echo "[Vulmini Restore] Flushing caches..."
    wp cache flush --allow-root 2>/dev/null || true
    wp rewrite flush --allow-root 2>/dev/null || true
    echo "[Vulmini Restore] ✅ Caches flushed"
}

# -- Main --
echo "[Vulmini Restore] Starting restore from backup: $BACKUP_ID (scope: $SCOPE)"

case "$SCOPE" in
    full)
        restore_db
        restore_plugins
        flush_caches
        ;;
    db)
        restore_db
        flush_caches
        ;;
    plugins)
        restore_plugins
        flush_caches
        ;;
    *)
        echo "Usage: $0 <backup_id> {full|db|plugins}"
        exit 1
        ;;
esac

echo ""
echo "[Vulmini Restore] ✅ Restore complete (backup_id: $BACKUP_ID, scope: $SCOPE)"
