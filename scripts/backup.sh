#!/bin/bash
# ==========================================
# VULMINI — Backup Script
# ==========================================
# Быстрый точечный бэкап БД и плагинов.
# Вызывается Gemini через MCP перед обновлениями на проде.
#
# Использование:
#   ./backup.sh full          — БД + все плагины
#   ./backup.sh db            — только БД
#   ./backup.sh plugin <slug> — конкретный плагин

set -euo pipefail

BACKUP_DIR="/var/www/html/wp-content/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
MAX_BACKUPS=5

# Создаём папку бэкапов
mkdir -p "$BACKUP_DIR"

backup_db() {
    echo "[Vulmini Backup] Dumping database..."
    local DUMP_FILE="$BACKUP_DIR/db_${TIMESTAMP}.sql.gz"
    wp db export - --allow-root | gzip > "$DUMP_FILE"
    echo "[Vulmini Backup] DB saved: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"
    echo "$DUMP_FILE"
}

backup_plugins() {
    local SCOPE="${1:-all}"
    if [ "$SCOPE" = "all" ]; then
        echo "[Vulmini Backup] Archiving all plugins..."
        local ARCHIVE="$BACKUP_DIR/plugins_${TIMESTAMP}.tar.gz"
        tar -czf "$ARCHIVE" -C /var/www/html/wp-content plugins/
    else
        echo "[Vulmini Backup] Archiving plugin: $SCOPE..."
        local ARCHIVE="$BACKUP_DIR/plugin_${SCOPE}_${TIMESTAMP}.tar.gz"
        tar -czf "$ARCHIVE" -C /var/www/html/wp-content "plugins/$SCOPE/"
    fi
    echo "[Vulmini Backup] Plugins saved: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
    echo "$ARCHIVE"
}

rotate_backups() {
    echo "[Vulmini Backup] Rotating old backups (keeping last $MAX_BACKUPS)..."
    ls -t "$BACKUP_DIR"/db_*.sql.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
    ls -t "$BACKUP_DIR"/plugins_*.tar.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
}

# ── Main ──
case "${1:-full}" in
    full)
        DB_FILE=$(backup_db)
        PLUGIN_FILE=$(backup_plugins "all")
        rotate_backups
        echo ""
        echo "[Vulmini Backup] ✅ Full backup complete"
        echo "  backup_id: ${TIMESTAMP}"
        echo "  db: ${DB_FILE}"
        echo "  plugins: ${PLUGIN_FILE}"
        ;;
    db)
        DB_FILE=$(backup_db)
        rotate_backups
        echo ""
        echo "[Vulmini Backup] ✅ DB backup complete"
        echo "  backup_id: ${TIMESTAMP}"
        echo "  db: ${DB_FILE}"
        ;;
    plugin)
        if [ -z "${2:-}" ]; then
            echo "[Vulmini Backup] ❌ Error: plugin slug required"
            echo "Usage: $0 plugin <slug>"
            exit 1
        fi
        PLUGIN_FILE=$(backup_plugins "$2")
        rotate_backups
        echo ""
        echo "[Vulmini Backup] ✅ Plugin backup complete"
        echo "  backup_id: ${TIMESTAMP}"
        echo "  plugin: ${PLUGIN_FILE}"
        ;;
    *)
        echo "Usage: $0 {full|db|plugin <slug>}"
        exit 1
        ;;
esac
