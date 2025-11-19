(function () {
  // Telegram WebApp detection
  const tg =
    window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const hasTelegram = !!tg;

  if (hasTelegram) {
    tg.expand();
  }

  /* -------------------------------------
     ELEMENTS
  ------------------------------------- */

  const greetingEl = document.getElementById("greeting");

  const titleInput = document.getElementById("title");
  const dateInput = document.getElementById("date");
  const timeInput = document.getElementById("time");

  const repeatHidden = document.getElementById("repeat");
  const categoryHidden = document.getElementById("category");
  const priorityHidden = document.getElementById("priority");
  const leadHidden = document.getElementById("lead");

  const leadCustomWrapper = document.getElementById("leadCustomWrapper");
  const leadCustomInput = document.getElementById("leadCustomInput");

  const categorySelect = document.getElementById("categorySelect");
  const addCategoryBtn = document.getElementById("addCategoryBtn");
  const filterCategorySelect = document.getElementById("filterCategory");

  const errorEl = document.getElementById("error");

  const previewMain = document.getElementById("preview-main");
  const previewDatetime = document.getElementById("preview-meta");
  const previewCategory = document.querySelector("#preview-category span");

  const repeatChips = document.querySelectorAll('[data-field="repeat"] .chip');
  const priorityChips = document.querySelectorAll(
    '[data-field="priority"] .chip'
  );
  const leadChips = document.querySelectorAll('[data-field="lead"] .chip');

  const tabs = document.querySelectorAll(".tab");
  const views = document.querySelectorAll(".view");
  const saveBtn = document.getElementById("saveBtn");

  const remindersListEl = document.getElementById("remindersList");
  const remindersEmptyEl = document.getElementById("remindersEmpty");

  /* -------------------------------------
     MODAL ELEMENTS
  ------------------------------------- */

  const categoryModal = document.getElementById("categoryModal");
  const categoryModalInput = document.getElementById("categoryModalInput");
  const categoryModalCancel = document.getElementById("categoryModalCancel");
  const categoryModalSave = document.getElementById("categoryModalSave");

  /* -------------------------------------
     STORAGE KEYS
  ------------------------------------- */

  const STORAGE_REMINDERS_KEY = "reminders_webapp";
  const STORAGE_CATEGORIES_KEY = "reminders_categories";

  let reminders = [];

  /* -------------------------------------
     TELEGRAM GREETING
  ------------------------------------- */

  function setGreeting() {
    if (!hasTelegram) return;
    try {
      const user = tg.initDataUnsafe?.user;
      if (user?.first_name) {
        greetingEl.textContent = `Create reminder, ${user.first_name}`;
      }
    } catch (e) {}
  }

  /* -------------------------------------
     DATE/TIME HELPERS
  ------------------------------------- */

  function applyDateTimeToInputs(dateObj) {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const hh = String(dateObj.getHours()).padStart(2, "0");
    const min = String(dateObj.getMinutes()).padStart(2, "0");

    dateInput.value = `${yyyy}-${mm}-${dd}`;
    timeInput.value = `${hh}:${min}`;
  }

  function setDefaultDateTime() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 10);
    now.setSeconds(0, 0);
    applyDateTimeToInputs(now);
  }

  function getScheduledDate() {
    const date = dateInput.value;
    const time = timeInput.value;
    if (!date || !time) return null;
    return new Date(`${date}T${time}`);
  }

  function formatDateTime(dt) {
    if (!dt || isNaN(dt.getTime())) return "not set";

    const today = new Date();
    const isToday =
      dt.getFullYear() === today.getFullYear() &&
      dt.getMonth() === today.getMonth() &&
      dt.getDate() === today.getDate();

    const options = { hour: "2-digit", minute: "2-digit" };
    const timeStr = dt.toLocaleTimeString(undefined, options);

    if (isToday) return `Today · ${timeStr}`;

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const isTomorrow =
      dt.getFullYear() === tomorrow.getFullYear() &&
      dt.getMonth() === tomorrow.getMonth() &&
      dt.getDate() === tomorrow.getDate();

    if (isTomorrow) return `Tomorrow · ${timeStr}`;

    const dateStr = dt.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

    return `${dateStr} · ${timeStr}`;
  }

  /* -------------------------------------
     CHIP HANDLING
  ------------------------------------- */

  function setupChipGroup(chips, hiddenInput, customHandler) {
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        if (customHandler) {
          customHandler(chip, chips, hiddenInput);
        } else {
          chips.forEach((c) => c.classList.remove("chip--active"));
          chip.classList.add("chip--active");
          hiddenInput.value = chip.dataset.value;
          updatePreview();
        }
      });
    });
  }

  function leadChipHandler(chip, chips, hiddenInput) {
    const val = chip.dataset.value;

    chips.forEach((c) => c.classList.remove("chip--active"));
    chip.classList.add("chip--active");

    hiddenInput.value = val;

    if (val === "custom") {
      leadCustomWrapper.style.display = "block";
      leadCustomInput.focus();
    } else {
      leadCustomWrapper.style.display = "none";
    }

    updatePreview();
  }

  /* -------------------------------------
     CATEGORY STORAGE
  ------------------------------------- */

  function loadCategories() {
    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_CATEGORIES_KEY) || "[]");
    } catch (e) {
      stored = [];
    }

    const defaults = ["Work", "Study", "Personal", "Health", "Other"];

    const all = ["", ...defaults, ...stored.filter((c) => !!c)];

    categorySelect.innerHTML = "";
    all.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat || "None";
      categorySelect.appendChild(opt);
    });

    filterCategorySelect.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All categories";
    filterCategorySelect.appendChild(allOpt);

    const added = new Set();
    all.forEach((cat) => {
      if (!cat || added.has(cat)) return;
      added.add(cat);
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      filterCategorySelect.appendChild(opt);
    });
  }

  function addCategory(name) {
    const trimmed = name.trim();
    if (!trimmed) return;

    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_CATEGORIES_KEY) || "[]");
    } catch (e) {
      stored = [];
    }

    if (!stored.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      stored.push(trimmed);
      localStorage.setItem(STORAGE_CATEGORIES_KEY, JSON.stringify(stored));
    }

    loadCategories();

    categorySelect.value = trimmed;
    categoryHidden.value = trimmed;
    updatePreview();
  }

  /* -------------------------------------
     PREVIEW
  ------------------------------------- */

  function updatePreview() {
    const title = titleInput.value.trim() || "Reminder";
    const dt = getScheduledDate();

    const repeatVal = repeatHidden.value;
    const priorityVal = priorityHidden.value;
    const categoryVal = categoryHidden.value || "None";

    const repeatMap = {
      once: "Once",
      weekly: "Every week",
      monthly: "Every month",
      yearly: "Every year",
    };

    const priorityMap = {
      low: "Low priority",
      normal: "Normal priority",
      urgent: "High priority",
    };

    const leadMap = {
      0: "At exact time",
      5: "5 min before",
      15: "15 min before",
      30: "30 min before",
      60: "1 hour before",
    };

    let leadLabel = leadMap[leadHidden.value] || "Custom time";

    if (leadHidden.value === "custom") {
      const m = parseInt(leadCustomInput.value || "0", 10);
      if (m > 0) leadLabel = `${m} min before`;
    }

    previewMain.innerHTML = `I’ll remind you: <strong>${escapeHtml(
      title
    )}</strong>`;

    previewDatetime.textContent =
      `${formatDateTime(dt)} · ${repeatMap[repeatVal]} · ${leadLabel} · ${priorityMap[priorityVal]}`;

    previewCategory.textContent = categoryVal;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>]/g, (tag) => {
      const chars = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
      return chars[tag] || tag;
    });
  }

  /* -------------------------------------
     REMINDER VALIDATION
  ------------------------------------- */

  function validateAndBuildPayload() {
    errorEl.textContent = "";
    const title = titleInput.value.trim() || "Reminder";

    const dt = getScheduledDate();
    if (!dt || isNaN(dt.getTime())) {
      errorEl.textContent = "Please choose a valid date and time.";
      return null;
    }

    const now = new Date();
    if (dt.getTime() <= now.getTime()) {
      errorEl.textContent = "Time must be in the future.";
      return null;
    }

    let leadMinutes = 0;
    if (leadHidden.value === "custom") {
      const m = parseInt(leadCustomInput.value || "0", 10);
      if (!m || m <= 0) {
        errorEl.textContent = "Enter custom minutes.";
        return null;
      }
      leadMinutes = m;
    } else {
      leadMinutes = parseInt(leadHidden.value, 10) || 0;
    }

    // Prevent reminders from triggering in the past
    if (dt.getTime() - leadMinutes * 60000 <= now.getTime()) {
      errorEl.textContent = "Lead time is too early.";
      return null;
    }

    return {
      id: Date.now().toString(),
      title,
      datetime: dt.toISOString(),
      repeat: repeatHidden.value,
      priority: priorityHidden.value,
      category: categoryHidden.value,
      remind_before_minutes: leadMinutes,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /* -------------------------------------
     LOCAL STORAGE REMINDERS LIST
  ------------------------------------- */

  function loadRemindersFromStorage() {
    try {
      reminders = JSON.parse(localStorage.getItem(STORAGE_REMINDERS_KEY) || "[]");
    } catch (e) {
      reminders = [];
    }
  }

  function saveRemindersToStorage() {
    localStorage.setItem(STORAGE_REMINDERS_KEY, JSON.stringify(reminders));
  }

  function renderReminders() {
    const filter = filterCategorySelect.value || "";

    remindersListEl.innerHTML = "";

    const filtered = reminders.filter((r) =>
      filter ? (r.category || "").toLowerCase() === filter.toLowerCase() : true
    );

    if (filtered.length === 0) {
      remindersEmptyEl.style.display = "block";
      return;
    }

    remindersEmptyEl.style.display = "none";

    filtered
      .slice()
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .forEach((rem) => {
        const li = document.createElement("li");
        li.className = "reminder-card";
        li.dataset.id = rem.id;

        const main = document.createElement("div");
        main.style.flex = "1";

        const titleRow = document.createElement("div");
        titleRow.style.display = "flex";
        titleRow.style.justifyContent = "space-between";
        titleRow.style.alignItems = "center";

        const titleSpan = document.createElement("span");
        titleSpan.className = "reminder-card-title";
        titleSpan.textContent = rem.title;
        titleRow.appendChild(titleSpan);

        if (rem.category) {
          const badge = document.createElement("span");
          badge.className = "reminder-card-badge";
          badge.textContent = rem.category;
          titleRow.appendChild(badge);
        }

        const meta = document.createElement("div");
        meta.className = "reminder-card-meta";

        const dtLabel = formatDateTime(new Date(rem.datetime));

        const repeatMap = {
          once: "Once",
          weekly: "Every week",
          monthly: "Every month",
          yearly: "Every year",
        };

        const leadLabel =
          rem.remind_before_minutes === 0
            ? "At exact time"
            : `${rem.remind_before_minutes} min before`;

        meta.textContent = `${dtLabel} · ${repeatMap[rem.repeat]} · ${leadLabel}`;

        main.appendChild(titleRow);
        main.appendChild(meta);

        const del = document.createElement("button");
        del.className = "reminder-card-delete";
        del.textContent = "×";
        del.onclick = () => deleteReminder(rem.id);

        li.appendChild(main);
        li.appendChild(del);
        remindersListEl.appendChild(li);
      });
  }

  function deleteReminder(id) {
    reminders = reminders.filter((r) => r.id !== id);
    saveRemindersToStorage();
    renderReminders();
  }

  /* -------------------------------------
     MODAL FUNCTIONS
  ------------------------------------- */

  function openCategoryModal() {
    categoryModal.classList.add("modal--open");
    categoryModalInput.value = "";
    setTimeout(() => categoryModalInput.focus(), 50);
  }

  function closeCategoryModal() {
    categoryModal.classList.remove("modal--open");
  }

  function handleCategoryModalSave() {
    const name = categoryModalInput.value.trim();
    if (!name) {
      categoryModalInput.focus();
      return;
    }
    addCategory(name);
    closeCategoryModal();
  }

  /* -------------------------------------
     SAVE HANDLER
  ------------------------------------- */

  function handleSave() {
    const payload = validateAndBuildPayload();
    if (!payload) return;

    reminders.push({
      id: payload.id,
      title: payload.title,
      datetime: payload.datetime,
      repeat: payload.repeat,
      priority: payload.priority,
      category: payload.category,
      remind_before_minutes: payload.remind_before_minutes,
    });

    saveRemindersToStorage();
    renderReminders();

    if (hasTelegram) {
      tg.sendData(JSON.stringify(payload));
      tg.showPopup({
        title: "Reminder saved",
        message: "I’ll remind you at the time you chose.",
        buttons: [{ id: "ok", type: "ok" }],
      });
      setTimeout(() => tg.close(), 400);
    } else {
      alert("Reminder created (browser mode). Check console.");
      console.log("Payload:", payload);
    }
  }

  /* -------------------------------------
     TABS SWITCHING
  ------------------------------------- */

  function switchTab(name) {
    tabs.forEach((t) => t.classList.toggle("tab--active", t.dataset.tab === name));
    views.forEach((v) => v.classList.toggle("view--active", v.id === `view-${name}`));
  }

  /* -------------------------------------
     EVENT BINDING
  ------------------------------------- */

  function bindEvents() {
    titleInput.addEventListener("input", updatePreview);
    dateInput.addEventListener("change", updatePreview);
    timeInput.addEventListener("change", updatePreview);
    leadCustomInput.addEventListener("input", updatePreview);

    setupChipGroup(repeatChips, repeatHidden);
    setupChipGroup(priorityChips, priorityHidden);
    setupChipGroup(leadChips, leadHidden, leadChipHandler);

    categorySelect.addEventListener("change", () => {
      categoryHidden.value = categorySelect.value;
      updatePreview();
    });

    addCategoryBtn.addEventListener("click", openCategoryModal);
    categoryModalCancel.addEventListener("click", closeCategoryModal);
    categoryModalSave.addEventListener("click", handleCategoryModalSave);

    categoryModalInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleCategoryModalSave();
      if (e.key === "Escape") closeCategoryModal();
    });

    categoryModal.addEventListener("click", (e) => {
      if (e.target === categoryModal) closeCategoryModal();
    });

    filterCategorySelect.addEventListener("change", renderReminders);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    saveBtn.addEventListener("click", handleSave);
  }

  /* -------------------------------------
     MAIN INIT
  ------------------------------------- */

  function init() {
    setGreeting();
    setDefaultDateTime();
    loadCategories();
    loadRemindersFromStorage();
    bindEvents();
    updatePreview();
    renderReminders();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
