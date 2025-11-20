(function () {
  const tg =
    window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const hasTelegram = !!tg;

  if (hasTelegram) {
    tg.expand();
  }

  /* ELEMENTS */

  const titleInput = document.getElementById("title");
  const dateInput = document.getElementById("date");
  const timeInput = document.getElementById("time");
  const noteInput = document.getElementById("note");

  const repeatHidden = document.getElementById("repeatHidden");
  const repeatSelect = document.getElementById("repeat");
  const leadHidden = document.getElementById("leadHidden");
  const categoryHidden = document.getElementById("categoryHidden");

  const categorySelect = document.getElementById("categorySelect");
  const addCategoryBtn = document.getElementById("addCategoryBtn");

  const filterCategorySelect = document.getElementById("filterCategory");

  const errorEl = document.getElementById("error");

  const previewTitle = document.getElementById("preview-title");
  const previewMeta = document.getElementById("preview-meta");
  const previewCategory = document.querySelector("#preview-category span");

  const leadChips = document.querySelectorAll('[data-field="lead"] .chip');

  const tabs = document.querySelectorAll(".tab");
  const views = document.querySelectorAll(".view");
  const viewCreate = document.getElementById("view-create");
  const saveBtn = document.getElementById("saveBtn");

  const remindersListEl = document.getElementById("remindersList");
  const remindersEmptyEl = document.getElementById("remindersEmpty");

  // Calendar elements
  const calendarMonthLabel = document.getElementById("calendarMonthLabel");
  const calendarGrid = document.getElementById("calendarGrid");
  const selectedDateLabel = document.getElementById("selectedDateLabel");
  const calPrevBtn = document.getElementById("calPrev");
  const calNextBtn = document.getElementById("calNext");

  // Modal
  const categoryModal = document.getElementById("categoryModal");
  const categoryModalInput = document.getElementById("categoryModalInput");
  const categoryModalCancel = document.getElementById("categoryModalCancel");
  const categoryModalSave = document.getElementById("categoryModalSave");

  // Edit banner
  const editBanner = document.getElementById("editBanner");
  const cancelEditBtn = document.getElementById("cancelEditBtn");

  const STORAGE_REMINDERS_KEY = "reminders_webapp";
  const STORAGE_CATEGORIES_KEY = "reminders_categories";

  let reminders = [];

  // timers for soft delete (undo delete)
  const pendingDeleteTimers = {};

  let currentMonth;
  let currentYear;
  let selectedDate;

  // id of reminder we are editing (null = creating new)
  let currentEditId = null;

  /* DATE/TIME HELPERS */

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
    const today = new Date();
    const isToday =
      dt.getFullYear() === today.getFullYear() &&
      dt.getMonth() === today.getMonth() &&
      dt.getDate() === today.getDate();

    const opts = { hour: "2-digit", minute: "2-digit" };
    const timeStr = dt.toLocaleTimeString(undefined, opts);

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

  /* CHIPS (lead) */

  function setupLeadChips() {
    leadChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const value = chip.dataset.value;
        leadHidden.value = value;

        leadChips.forEach((c) => c.classList.remove("chip--active"));
        chip.classList.add("chip--active");
        updatePreview();
      });
    });
  }

  /* PREVIEW */

  function updatePreview() {
    const title = titleInput.value.trim() || "Reminder";
    const dt = getScheduledDate();
    const repeatVal = repeatHidden.value;
    const categoryVal = categoryHidden.value || "None";

    const repeatMap = {
      once: "Once",
      weekly: "Every week",
      monthly: "Every month",
      yearly: "Every year",
    };

    let metaText = repeatMap[repeatVal] || "Once";

    if (dt && !isNaN(dt.getTime())) {
      metaText += " · " + formatDateTime(dt);
    }

    previewTitle.textContent = title;
    previewMeta.textContent = metaText;
    previewCategory.textContent = categoryVal;
  }

  /* STORAGE */

  function saveRemindersToStorage() {
    try {
      localStorage.setItem(STORAGE_REMINDERS_KEY, JSON.stringify(reminders));
    } catch (e) {
      console.error("Failed to save reminders", e);
    }
  }

  function loadRemindersFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_REMINDERS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        reminders = parsed;
      }
    } catch (e) {
      console.error("Failed to load reminders", e);
    }
  }

  function saveCategoriesToStorage(categories) {
    try {
      localStorage.setItem(STORAGE_CATEGORIES_KEY, JSON.stringify(categories));
    } catch (e) {
      console.error("Failed to save categories", e);
    }
  }

  function loadCategories() {
    let categories = [];
    try {
      const raw = localStorage.getItem(STORAGE_CATEGORIES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) categories = parsed;
      }
    } catch (e) {
      console.error("Failed to load categories", e);
    }

    // unique + sort
    const unique = Array.from(new Set(categories)).sort((a, b) =>
      a.localeCompare(b)
    );

    populateCategorySelects(unique);
  }

  function populateCategorySelects(categories) {
    const currentMain = categorySelect.value;
    const currentFilter = filterCategorySelect.value;

    categorySelect.innerHTML = "";
    filterCategorySelect.innerHTML = "";

    // main select
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "None";
    categorySelect.appendChild(noneOption);

    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      categorySelect.appendChild(opt);
    });

    // filter select
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All categories";
    filterCategorySelect.appendChild(allOpt);

    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      filterCategorySelect.appendChild(opt);
    });

    // restore selected values if still exist
    if ([...categorySelect.options].some((o) => o.value === currentMain)) {
      categorySelect.value = currentMain;
      categoryHidden.value = currentMain;
    }

    if ([...filterCategorySelect.options].some((o) => o.value === currentFilter)) {
      filterCategorySelect.value = currentFilter;
    }
  }

  /* CATEGORY MODAL */

  function openCategoryModal() {
    categoryModal.style.display = "flex";
    categoryModalInput.value = "";
    categoryModalInput.focus();
  }

  function closeCategoryModal() {
    categoryModal.style.display = "none";
  }

  function handleCategoryModalSave() {
    const value = categoryModalInput.value.trim();
    if (!value) {
      closeCategoryModal();
      return;
    }

    let categories = [];
    try {
      const raw = localStorage.getItem(STORAGE_CATEGORIES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) categories = parsed;
      }
    } catch (e) {
      console.error("Failed to load categories before save", e);
    }

    categories.push(value);
    categories = Array.from(new Set(categories));
    saveCategoriesToStorage(categories);
    populateCategorySelects(categories);

    // select newly created category
    categorySelect.value = value;
    categoryHidden.value = value;
    updatePreview();
    renderCalendar();
    renderReminders();

    closeCategoryModal();
  }

  /* VALIDATION */

  function validateAndBuildPayload() {
    // clear errors
    errorEl.textContent = "";
    [titleInput, dateInput, timeInput].forEach((el) =>
      el.classList.remove("field-input--error")
    );

    const rawTitle = titleInput.value.trim();
    if (!rawTitle) {
      errorEl.textContent = "Please add a title.";
      titleInput.classList.add("field-input--error");
      return null;
    }

    const dt = getScheduledDate();
    if (!dt || isNaN(dt.getTime())) {
      errorEl.textContent = "Please choose a valid date and time.";
      dateInput.classList.add("field-input--error");
      timeInput.classList.add("field-input--error");
      return null;
    }

    const now = new Date();
    if (dt.getTime() <= now.getTime()) {
      errorEl.textContent = "Time must be in the future.";
      dateInput.classList.add("field-input--error");
      timeInput.classList.add("field-input--error");
      return null;
    }

    const leadMinutes = parseInt(leadHidden.value, 10) || 0;

    if (dt.getTime() - leadMinutes * 60000 <= now.getTime()) {
      errorEl.textContent = "Lead time is too early.";
      dateInput.classList.add("field-input--error");
      timeInput.classList.add("field-input--error");
      return null;
    }

    return {
      id: currentEditId || Date.now().toString(),
      title: rawTitle,
      datetime: dt.toISOString(),
      repeat: repeatHidden.value,
      category: categoryHidden.value,
      note: noteInput.value.trim(),
      remind_before_minutes: leadMinutes,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /* FORM RESET + EDIT STATE */

  function resetFormToDefaults() {
    currentEditId = null;

    setDefaultDateTime();

    // text fields
    titleInput.value = "";
    noteInput.value = "";

    // category
    categoryHidden.value = "";
    categorySelect.value = "";

    // repeat
    repeatHidden.value = "once";
    repeatSelect.value = "once";

    // lead time (remind me)
    leadHidden.value = "0";
    leadChips.forEach((c) => {
      if (c.dataset.value === "0") {
        c.classList.add("chip--active");
      } else {
        c.classList.remove("chip--active");
      }
    });

    updatePreview();
  }

  /* SAVE BUTTON MODE */

  function setSaveMode(mode) {
    if (mode === "edit") {
      saveBtn.textContent = "Update reminder";
      saveBtn.classList.add("primary-btn--edit");
      editBanner.style.display = "flex";

      if (viewCreate) {
        viewCreate.classList.add("view--editing");
      }
    } else {
      saveBtn.textContent = "Save reminder";
      saveBtn.classList.remove("primary-btn--edit");
      editBanner.style.display = "none";
      currentEditId = null;

      if (viewCreate) {
        viewCreate.classList.remove("view--editing");
      }
    }
  }

  function cancelEdit() {
    setSaveMode("new");
    resetFormToDefaults();
  }

  /* RENDER REMINDERS LIST (for selected date) */

  // Soft delete: first click = mark red + start timer, second click = undo
  function handleDeleteClick(id, li, delBtn) {
    // If already pending -> this click means "undo"
    if (pendingDeleteTimers[id]) {
      clearTimeout(pendingDeleteTimers[id]);
      delete pendingDeleteTimers[id];

      li.classList.remove("reminder-card--pending-delete");
      delBtn.textContent = "×";
      delBtn.title = "Delete";

      renderReminders();
      return;
    }

    // First click: mark as pending delete
    li.classList.add("reminder-card--pending-delete");
    delBtn.textContent = "Undo";
    delBtn.title = "Undo delete";

    // After 10 seconds, delete for real if not undone
    pendingDeleteTimers[id] = setTimeout(() => {
      deleteReminder(id);
      delete pendingDeleteTimers[id];
    }, 10000);
  }

  function renderReminders() {
    if (!selectedDate) return;

    const filter = filterCategorySelect.value || "";
    remindersListEl.innerHTML = "";

    const filtered = reminders.filter((r) => {
      const rd = new Date(r.datetime);
      if (!sameDay(rd, selectedDate)) return false;
      if (
        filter &&
        (r.category || "").toLowerCase() !== filter.toLowerCase()
      ) {
        return false;
      }
      return true;
    });

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

        const main = document.createElement("div");
        main.className = "reminder-card-main";

        const titleRow = document.createElement("div");
        titleRow.className = "reminder-card-title-row";

        const titleEl = document.createElement("div");
        titleEl.className = "reminder-card-title";
        titleEl.textContent = rem.title;

        const badge = document.createElement("span");
        badge.className = "reminder-card-badge";
        badge.textContent = rem.category || "None";

        titleRow.appendChild(titleEl);
        titleRow.appendChild(badge);

        const metaRow = document.createElement("div");
        metaRow.className = "reminder-card-meta-row";

        const repeatMap = {
          once: "Once",
          weekly: "Every week",
          monthly: "Every month",
          yearly: "Every year",
        };

        const leadLabel =
          rem.remind_before_minutes === 0
            ? "At time"
            : `${rem.remind_before_minutes} min before`;

        const metaLeft = document.createElement("span");
        metaLeft.textContent = `${repeatMap[rem.repeat] || "Once"} · ${leadLabel}`;

        const timeLabel = new Date(rem.datetime).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });

        const metaRight = document.createElement("span");
        metaRight.textContent = timeLabel;

        metaRow.appendChild(metaLeft);
        metaRow.appendChild(metaRight);

        main.appendChild(titleRow);
        main.appendChild(metaRow);

        if (rem.note) {
          const noteEl = document.createElement("div");
          noteEl.className = "reminder-card-note";
          noteEl.textContent = rem.note;
          main.appendChild(noteEl);
        }

        // actions column
        const actions = document.createElement("div");
        actions.className = "reminder-card-actions";

        const editBtn = document.createElement("button");
        editBtn.className = "reminder-card-edit";
        editBtn.innerHTML = "✎";
        editBtn.title = "Edit";
        editBtn.onclick = (e) => {
          e.stopPropagation();
          startEditReminder(rem.id);
        };

        const delBtn = document.createElement("button");
        delBtn.className = "reminder-card-delete";
        delBtn.textContent = "×";
        delBtn.title = "Delete";
        delBtn.onclick = (e) => {
          e.stopPropagation();
          handleDeleteClick(rem.id, li, delBtn);
        };

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);

        li.appendChild(main);
        li.appendChild(actions);

        // edit ONLY via edit icon now (no card-wide click)
        remindersListEl.appendChild(li);
      });
  }

  function deleteReminder(id) {
    reminders = reminders.filter((r) => r.id !== id);
    saveRemindersToStorage();
    renderCalendar();
    renderReminders();
  }

  /* CALENDAR */

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function getRemindersForDay(date) {
    const filter = filterCategorySelect.value || "";
    return reminders.filter((r) => {
      const rd = new Date(r.datetime);
      if (!sameDay(rd, date)) return false;
      if (
        filter &&
        (r.category || "").toLowerCase() !== filter.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
  }

  function renderCalendar() {
    if (currentMonth == null || currentYear == null) return;

    const monthName = new Date(currentYear, currentMonth, 1).toLocaleString(
      undefined,
      {
        month: "long",
        year: "numeric",
      }
    );

    calendarMonthLabel.textContent = monthName;
    selectedDateLabel.textContent = selectedDate
      ? selectedDate.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : "";

    calendarGrid.innerHTML = "";

    const firstDay = new Date(currentYear, currentMonth, 1);
    const firstWeekday = (firstDay.getDay() + 6) % 7; // convert Sun=0 -> Mon=0
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    const today = new Date();

    // leading blanks
    for (let i = 0; i < firstWeekday; i++) {
      const cell = document.createElement("button");
      cell.className = "calendar-cell calendar-cell--empty";
      cell.disabled = true;
      calendarGrid.appendChild(cell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const cellDate = new Date(currentYear, currentMonth, day);
      const cell = document.createElement("button");
      cell.className = "calendar-cell";
      cell.textContent = day;

      if (sameDay(cellDate, today)) {
        cell.classList.add("calendar-cell--today");
      }
      if (selectedDate && sameDay(cellDate, selectedDate)) {
        cell.classList.add("calendar-cell--selected");
      }

      const dayReminders = getRemindersForDay(cellDate);
      if (dayReminders.length > 0) {
        cell.classList.add("calendar-cell--has-reminders");
      }

      cell.addEventListener("click", () => {
        selectedDate = cellDate;
        renderCalendar();
        renderReminders();
      });

      calendarGrid.appendChild(cell);
    }
  }

  /* SAVE HANDLER */

  function handleSave() {
    const payload = validateAndBuildPayload();
    if (!payload) return;

    const existingIndex = reminders.findIndex((r) => r.id === payload.id);
    const wasEditing = existingIndex !== -1;

    if (existingIndex === -1) {
      reminders.push(payload);
    } else {
      reminders.splice(existingIndex, 1, {
        ...reminders[existingIndex],
        title: payload.title,
        datetime: payload.datetime,
        repeat: payload.repeat,
        category: payload.category,
        note: payload.note,
        remind_before_minutes: payload.remind_before_minutes,
      });
    }

    saveRemindersToStorage();
    renderCalendar();
    renderReminders();
    setSaveMode("new");

    if (wasEditing) {
      resetFormToDefaults();
    }

    if (hasTelegram) {
      tg.HapticFeedback.impactOccurred("medium");
    }
  }

  /* EDIT EXISTING REMINDER */

  function startEditReminder(id) {
    const rem = reminders.find((r) => r.id === id);
    if (!rem) return;

    currentEditId = rem.id;

    titleInput.value = rem.title;
    noteInput.value = rem.note || "";

    const dt = new Date(rem.datetime);
    applyDateTimeToInputs(dt);

    repeatHidden.value = rem.repeat;
    repeatSelect.value = rem.repeat;

    categoryHidden.value = rem.category || "";
    categorySelect.value = rem.category || "";

    leadHidden.value = String(rem.remind_before_minutes || 0);
    leadChips.forEach((c) => {
      if (c.dataset.value === String(rem.remind_before_minutes || 0)) {
        c.classList.add("chip--active");
      } else {
        c.classList.remove("chip--active");
      }
    });

    updatePreview();
    setSaveMode("edit");
    switchTab("create");
  }

  /* SIMPLE TAB SWITCH */

  function switchTab(name) {
    tabs.forEach((t) =>
      t.classList.toggle("tab--active", t.dataset.tab === name)
    );
    views.forEach((v) =>
      v.classList.toggle("view--active", v.id === `view-${name}`)
    );
  }

  /* EVENTS */

  function bindEvents() {
    titleInput.addEventListener("input", updatePreview);
    dateInput.addEventListener("change", updatePreview);
    timeInput.addEventListener("change", updatePreview);
    noteInput.addEventListener("input", () => {});

    repeatSelect.addEventListener("change", () => {
      repeatHidden.value = repeatSelect.value;
      updatePreview();
    });

    setupLeadChips();

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

    filterCategorySelect.addEventListener("change", () => {
      renderCalendar();
      renderReminders();
    });

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;

        if (target === "create") {
          // Only reset if we are NOT editing an existing reminder
          if (!currentEditId) {
            setSaveMode("new");
            resetFormToDefaults();
          }
        }

        switchTab(target);
      });
    });

    saveBtn.addEventListener("click", handleSave);
    cancelEditBtn.addEventListener("click", cancelEdit);

    calPrevBtn.addEventListener("click", () => {
      currentMonth--;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
      }
      renderCalendar();
      renderReminders();
    });

    calNextBtn.addEventListener("click", () => {
      currentMonth++;
      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
      }
      renderCalendar();
      renderReminders();
    });
  }

  /* INIT */

  function init() {
    const today = new Date();
    currentMonth = today.getMonth();
    currentYear = today.getFullYear();
    selectedDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );

    loadCategories();
    loadRemindersFromStorage();
    bindEvents();
    setSaveMode("new");
    resetFormToDefaults();
    renderCalendar();
    renderReminders();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
