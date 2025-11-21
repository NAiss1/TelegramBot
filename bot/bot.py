import os
import json
import datetime
from zoneinfo import ZoneInfo
import logging

from dotenv import load_dotenv
from telegram import (
    Update,
    KeyboardButton,
    ReplyKeyboardMarkup,
    WebAppInfo,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)

from db import (
    init_db,
    add_reminder,
    get_reminder,
    update_reminder_status,
    update_reminder_datetime,
    get_upcoming_reminders_for_chat,
    get_all_pending_reminders,
)

# ---------- Logging setup ----------

logging.basicConfig(
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ---------- Env ----------

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEB_APP_URL = os.getenv("WEB_APP_URL")

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is not set. Add it to your .env file.")
if not WEB_APP_URL:
    raise RuntimeError("WEB_APP_URL is not set. Add it to your .env file.")


# ---------- Time helpers ----------

def parse_client_datetime_to_utc(datetime_str: str, timezone_name: str | None) -> datetime.datetime:
    """
    OLD FORMAT SUPPORT:
    datetime_str: 'YYYY-MM-DDTHH:MM' in user's local timezone
    timezone_name: IANA tz string like 'America/Toronto'
    Returns an aware UTC datetime.
    """
    naive_local = datetime.datetime.strptime(datetime_str, "%Y-%m-%dT%H:%M")
    if timezone_name:
        try:
            tz = ZoneInfo(timezone_name)
            aware_local = naive_local.replace(tzinfo=tz)
        except Exception:
            logger.warning("Failed to apply timezone %s, falling back to UTC", timezone_name)
            aware_local = naive_local.replace(tzinfo=datetime.timezone.utc)
    else:
        aware_local = naive_local.replace(tzinfo=datetime.timezone.utc)

    utc_dt = aware_local.astimezone(datetime.timezone.utc)
    logger.debug("Parsed old-format datetime %s (%s) -> %s UTC", datetime_str, timezone_name, utc_dt)
    return utc_dt


def format_for_user(reminder: dict) -> str:
    """Format reminder time/text back into user's timezone (if we have it)."""
    utc_dt = datetime.datetime.fromisoformat(reminder["datetime_utc"])
    utc_dt = utc_dt.replace(tzinfo=datetime.timezone.utc)

    tz_name = reminder.get("timezone")
    if tz_name:
        try:
            tz = ZoneInfo(tz_name)
            local_dt = utc_dt.astimezone(tz)
        except Exception:
            logger.warning("Failed to convert to user timezone %s, using UTC", tz_name)
            local_dt = utc_dt
    else:
        local_dt = utc_dt

    time_str = local_dt.strftime("%Y-%m-%d %H:%M")

    repeat = reminder.get("repeat", "none")
    repeat_label = {
        "none": "one-time",
        "daily": "every day",
        "weekly": "every week",
    }.get(repeat, repeat)

    priority = reminder.get("priority", "normal")
    priority_label = {
        "low": "low",
        "normal": "normal",
        "urgent": "urgent",
    }.get(priority, priority)

    cat = reminder.get("category") or "No category"

    return (
        f"*{reminder['title']}*\n"
        f"🕒 {time_str}\n"
        f"🔁 {repeat_label}\n"
        f"⚙️ Priority: {priority_label}\n"
        f"🏷 Category: {cat}"
    )


# ---------- Command handlers ----------

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send start message with WebApp button."""
    chat_id = update.effective_chat.id if update.effective_chat else None
    logger.info("/start from chat_id=%s", chat_id)

    button = KeyboardButton(
        text="Open NAiss REM",
        web_app=WebAppInfo(url=WEB_APP_URL),
    )
    keyboard = ReplyKeyboardMarkup([[button]], resize_keyboard=True)

    await update.message.reply_text(
        "Hi! This is NAiss REM.\n\nTap the button below to open the reminder app, "
        "or use /reminders to see upcoming reminders.",
        reply_markup=keyboard,
    )


async def reminders_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """List upcoming reminders for this chat."""
    chat_id = update.effective_chat.id
    logger.info("/reminders requested for chat_id=%s", chat_id)

    reminders = get_upcoming_reminders_for_chat(chat_id, limit=10)

    if not reminders:
        await update.message.reply_text("You have no upcoming reminders.")
        return

    lines = []
    for r in reminders:
        status = r["status"]
        prefix = "⏰" if status == "pending" else "✅"
        lines.append(f"{prefix} #{r['id']}:\n{format_for_user(r)}")

    await update.message.reply_text("\n\n".join(lines), parse_mode="Markdown")


# ---------- DEBUG handler (logs ALL updates) ----------

async def debug_update(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Log every update so we see what Telegram is sending."""
    if update.message:
        msg = update.message
        logger.info(
            "DEBUG update: chat_id=%s text=%r web_app_data=%r",
            msg.chat_id,
            msg.text,
            getattr(msg, "web_app_data", None),
        )
    elif update.callback_query:
        cq = update.callback_query
        logger.info(
            "DEBUG callback_query: chat_id=%s data=%r",
            cq.message.chat_id if cq.message else None,
            cq.data,
        )
    else:
        logger.info("DEBUG non-message update: %s", update)


# ---------- WebApp data handler ----------

async def webapp_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Handle data coming from the WebApp.
    Expected payload from frontend (JS):

    {
      id,
      title,
      datetime,              // ISO string (toISOString())
      repeat,                // once/weekly/monthly/yearly
      category,
      note,
      remind_before_minutes,
      timezone
    }
    """
    if not update.message or not update.message.web_app_data:
        return

    chat_id = update.effective_chat.id
    raw_data = update.message.web_app_data.data
    logger.info("Received web_app_data from chat_id=%s: %s", chat_id, raw_data)

    try:
        data = json.loads(raw_data)
    except json.JSONDecodeError:
        logger.exception("JSON decode error for web_app_data")
        await update.message.reply_text("❌ Could not parse reminder data.")
        return

    title = (data.get("title") or "Reminder").strip()
    datetime_str = data.get("datetime")
    timezone_name = data.get("timezone")
    priority = data.get("priority", "normal")
    category = data.get("category") or None

    # Map WebApp repeat → DB repeat
    web_repeat = (data.get("repeat") or "once").lower()
    repeat_map = {
        "once": "none",    # one-time
        "none": "none",
        "daily": "daily",
        "weekly": "weekly",
        # monthly/yearly not implemented → treat as one-time for now
        "monthly": "none",
        "yearly": "none",
    }
    repeat = repeat_map.get(web_repeat, "none")

    remind_before_minutes = int(data.get("remind_before_minutes", 0) or 0)

    logger.info(
        "Parsed payload: chat_id=%s title=%r datetime=%s tz=%s repeat_web=%s repeat_db=%s lead=%s",
        chat_id,
        title,
        datetime_str,
        timezone_name,
        web_repeat,
        repeat,
        remind_before_minutes,
    )

    if not datetime_str:
        await update.message.reply_text("❌ No date/time provided.")
        return

    # --- Parse datetime ---
    try:
        iso_candidate = datetime_str
        if iso_candidate.endswith("Z"):
            iso_candidate = iso_candidate.replace("Z", "+00:00")

        utc_dt: datetime.datetime

        try:
            dt_parsed = datetime.datetime.fromisoformat(iso_candidate)
            if dt_parsed.tzinfo is None:
                # attach user's timezone if we know it, else UTC
                if timezone_name:
                    try:
                        tz = ZoneInfo(timezone_name)
                        dt_parsed = dt_parsed.replace(tzinfo=tz)
                    except Exception:
                        logger.warning(
                            "Failed to apply frontend timezone %s, using UTC",
                            timezone_name,
                        )
                        dt_parsed = dt_parsed.replace(tzinfo=datetime.timezone.utc)
                else:
                    dt_parsed = dt_parsed.replace(tzinfo=datetime.timezone.utc)
            utc_dt = dt_parsed.astimezone(datetime.timezone.utc)
        except Exception:
            # fallback to old short format 'YYYY-MM-DDTHH:MM'
            logger.warning("Falling back to old datetime format parsing for %s", datetime_str)
            utc_dt = parse_client_datetime_to_utc(datetime_str[:16], timezone_name)

        now_utc = datetime.datetime.now(datetime.timezone.utc)

        # notification time = event - lead_minutes
        utc_notify = utc_dt - datetime.timedelta(minutes=remind_before_minutes)
        delay_seconds = (utc_notify - now_utc).total_seconds()

        logger.info(
            "Computed UTC times for chat_id=%s: event=%s notify=%s delay_seconds=%.2f",
            chat_id,
            utc_dt,
            utc_notify,
            delay_seconds,
        )

        if delay_seconds <= 0:
            await update.message.reply_text("⏰ Time must be in the future.")
            return

    except ValueError:
        logger.exception("ValueError while parsing datetime for chat_id=%s", chat_id)
        await update.message.reply_text("❌ Invalid date/time format.")
        return

    # --- Save to DB (store actual event time in datetime_utc) ---
    reminder_id = add_reminder(
        chat_id=chat_id,
        title=title,
        datetime_utc_iso=utc_dt.isoformat(),
        timezone=timezone_name,
        priority=priority,
        category=category,
        repeat=repeat,
    )

    logger.info(
        "Saved reminder id=%s for chat_id=%s at %s (UTC). Repeat=%s Lead=%s",
        reminder_id,
        chat_id,
        utc_dt.isoformat(),
        repeat,
        remind_before_minutes,
    )

    # --- Schedule job ---
    context.job_queue.run_once(
        send_reminder_job,
        when=delay_seconds,
        chat_id=chat_id,
        data={"reminder_id": reminder_id},
        name=f"reminder-{reminder_id}",
    )

    logger.info(
        "Scheduled job for reminder id=%s (chat_id=%s) in %.2f seconds",
        reminder_id,
        chat_id,
        delay_seconds,
    )

    await update.message.reply_text(
        f"✅ Reminder saved (#{reminder_id}):\n{format_for_user(get_reminder(reminder_id))}",
        parse_mode="Markdown",
    )


# ---------- Job: send reminder ----------

async def send_reminder_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    job = context.job
    reminder_id = job.data["reminder_id"]

    logger.info("send_reminder_job fired for reminder_id=%s chat_id=%s", reminder_id, job.chat_id)

    reminder = get_reminder(reminder_id)
    if not reminder or reminder["status"] != "pending":
        logger.info(
            "Reminder id=%s not found or not pending (status=%s), skipping job",
            reminder_id,
            reminder["status"] if reminder else None,
        )
        return

    text = f"{'⚠️' if reminder['priority']=='urgent' else '⏰'} *Reminder* #{reminder_id}\n"
    text += format_for_user(reminder)

    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("Snooze 10 min", callback_data=f"snooze10:{reminder_id}"),
                InlineKeyboardButton("Snooze 1 h", callback_data=f"snooze60:{reminder_id}"),
            ],
            [
                InlineKeyboardButton("Mark as done", callback_data=f"cancel:{reminder_id}"),
            ],
        ]
    )

    await context.bot.send_message(
        chat_id=job.chat_id,
        text=text,
        reply_markup=keyboard,
        parse_mode="Markdown",
    )

    if reminder["priority"] == "urgent":
        await context.bot.send_message(
            chat_id=job.chat_id,
            text="⚠️ This reminder is *urgent*. Use the buttons above to snooze or mark done.",
            parse_mode="Markdown",
        )

    repeat = reminder.get("repeat", "none")
    if repeat == "none":
        update_reminder_status(reminder_id, "done")
        logger.info("Reminder id=%s marked as done (no repeat)", reminder_id)
    else:
        utc_dt = datetime.datetime.fromisoformat(reminder["datetime_utc"]).replace(
            tzinfo=datetime.timezone.utc
        )
        if repeat == "daily":
            next_dt = utc_dt + datetime.timedelta(days=1)
        elif repeat == "weekly":
            next_dt = utc_dt + datetime.timedelta(weeks=1)
        else:
            next_dt = utc_dt

        update_reminder_datetime(reminder_id, next_dt.isoformat())
        logger.info(
            "Reminder id=%s is repeating (%s). Next datetime_utc=%s",
            reminder_id,
            repeat,
            next_dt.isoformat(),
        )
        schedule_job_for_reminder(get_reminder(reminder_id), context.job_queue)


# ---------- Callback: snooze / cancel ----------

async def reminder_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    data = query.data  # e.g. "snooze10:12"
    try:
        action, rid_str = data.split(":")
        reminder_id = int(rid_str)
    except Exception:
        logger.exception("Invalid callback data: %s", data)
        await query.edit_message_text("❌ Invalid action.")
        return

    reminder = get_reminder(reminder_id)
    if not reminder:
        logger.info("Reminder id=%s not found for callback %s", reminder_id, data)
        await query.edit_message_text("This reminder no longer exists.")
        return

    chat_id = update.effective_chat.id if update.effective_chat else None

    if action == "cancel":
        update_reminder_status(reminder_id, "done")
        logger.info(
            "Reminder id=%s cancelled by user (chat_id=%s)",
            reminder_id,
            chat_id,
        )
        await query.edit_message_text("✅ Reminder marked as done.")
        return

    # Snooze 10 or 60 minutes
    minutes = 10 if action == "snooze10" else 60
    new_dt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    update_reminder_datetime(reminder_id, new_dt.isoformat())
    schedule_job_for_reminder(get_reminder(reminder_id), context.job_queue)

    logger.info(
        "Reminder id=%s snoozed by %s minutes (chat_id=%s), new_datetime_utc=%s",
        reminder_id,
        minutes,
        chat_id,
        new_dt.isoformat(),
    )

    await query.edit_message_text(f"⏰ Reminder snoozed for {minutes} minutes.")


# ---------- Scheduling helper ----------

def schedule_job_for_reminder(reminder: dict, job_queue) -> None:
    """Schedule a job for a reminder (used on startup & for repeats)."""
    utc_dt = datetime.datetime.fromisoformat(reminder["datetime_utc"]).replace(
        tzinfo=datetime.timezone.utc
    )
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    delay_seconds = (utc_dt - now_utc).total_seconds()
    if delay_seconds <= 0:
        logger.info(
            "Not scheduling reminder id=%s (chat_id=%s) because delay_seconds=%.2f <= 0",
            reminder["id"],
            reminder["chat_id"],
            delay_seconds,
        )
        return

    logger.info(
        "Scheduling reminder id=%s (chat_id=%s) in %.2f seconds",
        reminder["id"],
        reminder["chat_id"],
        delay_seconds,
    )

    job_queue.run_once(
        send_reminder_job,
        when=delay_seconds,
        chat_id=reminder["chat_id"],
        data={"reminder_id": reminder["id"]},
        name=f"reminder-{reminder['id']}",
    )


async def on_startup(app: Application) -> None:
    """On startup, schedule jobs for all pending reminders."""
    logger.info("Scheduling pending reminders from DB on startup...")
    logger.info("Job queue present: %s", bool(app.job_queue))
    pending = get_all_pending_reminders()
    logger.info("Found %d pending reminders in DB", len(pending))
    for r in pending:
        schedule_job_for_reminder(r, app.job_queue)


# ---------- Main ----------

def main() -> None:
    init_db()

    app = Application.builder().token(BOT_TOKEN).build()

    # 1) DEBUG handler first (block=False so other handlers still run)
    app.add_handler(MessageHandler(filters.ALL, debug_update, block=False))

    # 2) commands
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("reminders", reminders_cmd))

    # 3) WebApp data – use proper WEB_APP_DATA filter now
    app.add_handler(
        MessageHandler(
            filters.StatusUpdate.WEB_APP_DATA,
            webapp_data_handler,
        )
    )

    # 4) callback buttons
    app.add_handler(
        CallbackQueryHandler(reminder_callback, pattern=r"^(snooze10|snooze60|cancel):\d+$")
    )

    # schedule pending reminders
    app.post_init = on_startup

    logger.info("Bot is starting run_polling()...")
    app.run_polling()


if __name__ == "__main__":
    main()
