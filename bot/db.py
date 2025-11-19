import sqlite3
import datetime
from typing import List, Optional, Dict, Any

DB_PATH = "reminders.db"


def get_conn():
    return sqlite3.connect(DB_PATH)


def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            datetime_utc TEXT NOT NULL,
            timezone TEXT,
            priority TEXT NOT NULL,
            category TEXT,
            repeat TEXT NOT NULL DEFAULT 'none',  -- none / daily / weekly
            status TEXT NOT NULL DEFAULT 'pending' -- pending / done / cancelled
        )
        """
    )
    conn.commit()
    conn.close()


def add_reminder(
    chat_id: int,
    title: str,
    datetime_utc_iso: str,
    timezone: Optional[str],
    priority: str,
    category: Optional[str],
    repeat: str,
) -> int:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO reminders (chat_id, title, datetime_utc, timezone, priority, category, repeat, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (chat_id, title, datetime_utc_iso, timezone, priority, category, repeat),
    )
    rid = cur.lastrowid
    conn.commit()
    conn.close()
    return rid


def get_reminder(reminder_id: int) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,))
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def update_reminder_status(reminder_id: int, status: str) -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE reminders SET status = ? WHERE id = ?",
        (status, reminder_id),
    )
    conn.commit()
    conn.close()


def update_reminder_datetime(reminder_id: int, datetime_utc_iso: str) -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE reminders SET datetime_utc = ? WHERE id = ?",
        (datetime_utc_iso, reminder_id),
    )
    conn.commit()
    conn.close()


def get_upcoming_reminders_for_chat(
    chat_id: int,
    limit: int = 10,
) -> List[Dict[str, Any]]:
    conn = get_conn()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    now_utc = datetime.datetime.utcnow().isoformat()
    cur.execute(
        """
        SELECT * FROM reminders
        WHERE chat_id = ? AND status = 'pending' AND datetime_utc >= ?
        ORDER BY datetime_utc ASC
        LIMIT ?
        """,
        (chat_id, now_utc, limit),
    )
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_pending_reminders() -> List[Dict[str, Any]]:
    conn = get_conn()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    now_utc = datetime.datetime.utcnow().isoformat()
    cur.execute(
        """
        SELECT * FROM reminders
        WHERE status = 'pending' AND datetime_utc >= ?
        """,
        (now_utc,),
    )
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]
