import os
import json
import datetime
from zoneinfo import ZoneInfo

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

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEB_APP_URL = os.getenv("WEB_APP_URL")

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is not set. Add it to your .env file.")
if not WEB_APP_URL:
    raise RuntimeError("WEB_APP_URL is not set. Add it to your .env file.")


# ---------- Helpers ----------

def parse_client_datetime_to_utc(datetime_str: str, timezone_name: str | None) -> datetime.datetime:
    """
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
            # fallback: treat as server local
            aware_local = naive_local.astimezone(datetime.timezone.utc)
    else:
        aware_local = naive_local.astimezone(datetime.timezone.utc)

    utc_dt = aware_local.astimezone(datetime.timezone.utc)
    return utc_dt


def format_for_user(reminder: dict) -> str:
    """Format time back into user's timezone (if we have it)."""
    utc_dt = datetime.datetime.fromisoformat(reminder["datetime_utc"])
    utc_dt = utc_dt.replace(tzinfo=datetime.timezone.utc)

    tz_name = reminder.get("timezone")
    if tz_name:
        try:
            tz = ZoneInfo(tz_name)
            local_dt = utc_dt.astimezone(tz)
        except Exception:
            local_dt = utc_dt
    else:
        local_dt = utc_dt

    time_str = local_dt.strftime("%Y-%m-%d %H:%M")
    pieces = [f"{time_str}"]

    cat = reminder.get("category")
    if cat:
        pieces.append(f"[{cat}]")

    pieces.append(reminder.get("title", "Reminder"))
    pieces.append(f"({reminder.get('priority', 'normal')})")

    return " ".join(pieces)

from telegram.ext import JobQueue  # add this to the imports at top with others

def schedule_job_for_reminder(reminder: dict, job_queue: JobQueue):
    utc_dt = datetime.datetime.fromisoformat(reminder["datetime_utc"]).replace(
        tzinfo=datetime.timezone.utc
    )
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    delay = (utc_dt - now_utc).total_seconds()
    if delay <= 0:
        return

    reminder_id = reminder["id"]
    chat_id = reminder["chat_id"]

    job_queue.run_once(
        send_reminder_job,
        when=delay,
        chat_id=chat_id,
        data={"reminder_id": reminder_id},
        name=f"reminder-{reminder_id}",
    )

# ---------- Command Handlers ----------

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    button = KeyboardButton(
        text="📅 Open Reminder App",
        web_app=WebAppInfo(url=WEB_APP_URL),
    )
    keyboard = ReplyKeyboardMarkup([[button]], resize_keyboard=True)

    await update.message.reply_text(
        "Hi! I’m your reminder assistant.\n\n"
        "Tap the button below to open the reminder app, or use /reminders to see upcoming reminders.",
        reply_markup=keyboard,
    )


async def reminders_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    reminders = get_upcoming_reminders_for_chat(chat_id, limit=10)

    if not reminders:
        await update.message.reply_text("You have no upcoming reminders.")
        return

    lines = []
    for r in reminders:
        line = f"#{r['id']} • {format_for_user(r)} • repeat={r['repeat']}"
        lines.append(line)

    msg = "Your upcoming reminders:\n\n" + "\n".join(lines)
    await update.message.reply_text(msg)


# ---------- WebApp data handler ----------

async def webapp_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.web_app_data:
        return

    chat_id = update.effective_chat.id
    raw_data = update.message.web_app_data.data

    try:
        data = json.loads(raw_data)
    except json.JSONDecodeError:
        await update.message.reply_text("❌ Could not parse reminder data.")
        return

    title = data.get("title", "Reminder")
    datetime_str = data.get("datetime")  # "YYYY-MM-DDTHH:MM"
    priority = data.get("priority", "normal")
    category = data.get("category") or None
    repeat = data.get("repeat", "none")  # none / daily / weekly
    timezone_name = data.get("timezone")  # IANA string

    if not datetime_str:
        await update.message.reply_text("❌ No date/time provided.")
        return

    try:
        utc_dt = parse_client_datetime_to_utc(datetime_str, timezone_name)
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        delay_seconds = (utc_dt - now_utc).total_seconds()
        if delay_seconds <= 0:
            await update.message.reply_text("⏰ Time must be in the future.")
            return
    except ValueError:
        await update.message.reply_text("❌ Invalid date/time format.")
        return

    # Store in DB
    reminder_id = add_reminder(
        chat_id=chat_id,
        title=title,
        datetime_utc_iso=utc_dt.isoformat(),
        timezone=timezone_name,
        priority=priority,
        category=category,
        repeat=repeat,
    )

    # Schedule job
    context.job_queue.run_once(
        send_reminder_job,
        when=delay_seconds,
        chat_id=chat_id,
        data={"reminder_id": reminder_id},
        name=f"reminder-{reminder_id}",
    )

    await update.message.reply_text(
        f"✅ Reminder saved (#{reminder_id}):\n"
        f"{format_for_user(get_reminder(reminder_id))}"
    )


# ---------- Job: send reminder ----------

async def send_reminder_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    job = context.job
    reminder_id = job.data["reminder_id"]

    reminder = get_reminder(reminder_id)
    if not reminder or reminder["status"] != "pending":
        return

    text_main = f"{'⚠️' if reminder['priority']=='urgent' else '⏰'} *Reminder* #{reminder_id}\n"
    text_main += f"{format_for_user(reminder)}"

    # Inline buttons: snooze & cancel
    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("Snooze 10 min", callback_data=f"snooze10:{reminder_id}"),
                InlineKeyboardButton("Snooze 1 hour", callback_data=f"snooze60:{reminder_id}"),
            ],
            [
                InlineKeyboardButton("Mark done / cancel", callback_data=f"cancel:{reminder_id}")
            ],
        ]
    )

    await context.bot.send_message(
        chat_id=job.chat_id,
        text=text_main,
        reply_markup=keyboard,
        parse_mode="Markdown",
    )

    # For urgent reminders, send an extra ping text
    if reminder["priority"] == "urgent":
        await context.bot.send_message(
            chat_id=job.chat_id,
            text="⚠️ This was marked as *urgent*. You can snooze or cancel it using the buttons above.",
            parse_mode="Markdown",
        )

    # Handle repeat: if no repeat, we'll mark done here;
    # if repeat is daily/weekly, we schedule next occurrence.
    repeat = reminder.get("repeat", "none")
    if repeat == "none":
        update_reminder_status(reminder_id, "done")
    else:
        # compute next datetime in UTC
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
        # schedule next
        schedule_job_for_reminder(get_reminder(reminder_id), context.job_queue)



# ---------- Callback: Snooze / Cancel ----------

async def reminder_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    data = query.data  # e.g. "snooze10:12"
    try:
        action, rid_str = data.split(":")
        reminder_id = int(rid_str)
    except Exception:
        await query.edit_message_reply_markup(reply_markup=None)
        return

    reminder = get_reminder(reminder_id)
    if not reminder or reminder["status"] != "pending":
        await query.edit_message_text("This reminder is already done or cancelled.")
        return

    # cancel old job(s)
    jobs = context.job_queue.get_jobs_by_name(f"reminder-{reminder_id}")
    for j in jobs:
        j.schedule_removal()

    if action.startswith("snooze"):
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        if action == "snooze10":
            new_dt = now_utc + datetime.timedelta(minutes=10)
        else:
            new_dt = now_utc + datetime.timedelta(hours=1)

        update_reminder_datetime(reminder_id, new_dt.isoformat())
        schedule_job_for_reminder(get_reminder(reminder_id), context.job_queue)


        await query.edit_message_text(
            f"🔁 Reminder #{reminder_id} snoozed.\nNext time: {format_for_user(get_reminder(reminder_id))}"
        )

    elif action == "cancel":
        update_reminder_status(reminder_id, "cancelled")
        await query.edit_message_text(f"✅ Reminder #{reminder_id} marked as done / cancelled.")


# ---------- App bootstrap ----------

async def on_startup(app: Application) -> None:
    print("Scheduling pending reminders from DB...")
    for r in get_all_pending_reminders():
        schedule_job_for_reminder(r, app.job_queue)
    print("Done scheduling pending reminders.")


def main() -> None:
    init_db()

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("reminders", reminders_cmd))

    app.add_handler(
        MessageHandler(
            filters.StatusUpdate.WEB_APP_DATA,
            webapp_data_handler,
        )
    )

    app.add_handler(
        CallbackQueryHandler(reminder_callback, pattern=r"^(snooze10|snooze60|cancel):\d+$")
    )

    app.post_init = on_startup

    print("Bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
