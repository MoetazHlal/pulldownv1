(() => {
  "use strict";

  const QUALITY_OPTIONS = [
    { value: "2160", label: "2160p · 4K" },
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
    { value: "360", label: "360p" },
    { value: "audio", label: "Audio only · MP3" },
  ];
  const DEFAULT_QUALITY = "1080";

  const els = {
    themeToggle: document.getElementById("themeToggle"),
    tabYoutube: document.getElementById("tabYoutube"),
    tabInstagram: document.getElementById("tabInstagram"),
    form: document.getElementById("urlForm"),
    input: document.getElementById("urlInput"),
    fetchBtn: document.getElementById("fetchBtn"),
    statusLine: document.getElementById("statusLine"),
    preview: document.getElementById("preview"),
    previewThumb: document.getElementById("previewThumb"),
    previewTitle: document.getElementById("previewTitle"),
    previewAuthor: document.getElementById("previewAuthor"),
    qualitySection: document.getElementById("qualitySection"),
    qualityList: document.getElementById("qualityList"),
    downloadBtn: document.getElementById("downloadBtn"),
    downloadBtnLabel: document.getElementById("downloadBtnLabel"),
    pickerSection: document.getElementById("pickerSection"),
    pickerList: document.getElementById("pickerList"),
    youtubeNotice: document.getElementById("youtubeNotice"),
  };

  const state = {
    platform: "youtube",
    quality: DEFAULT_QUALITY,
    currentUrl: "",
  };

  // ---------------- theme ----------------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    els.themeToggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  const savedTheme = localStorage.getItem("pulldown-theme");
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (systemPrefersDark ? "dark" : "light"));

  els.themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem("pulldown-theme", next);
  });

  // ---------------- platform tabs ----------------

  function setPlatform(platform) {
    state.platform = platform;
    const isYT = platform === "youtube";
    els.tabYoutube.classList.toggle("is-active", isYT);
    els.tabYoutube.setAttribute("aria-selected", String(isYT));
    els.tabInstagram.classList.toggle("is-active", !isYT);
    els.tabInstagram.setAttribute("aria-selected", String(!isYT));
    els.input.placeholder = isYT ? "Paste a YouTube link…" : "Paste an Instagram reel link…";
    els.youtubeNotice.hidden = !isYT;
    resetResults();
  }

  els.tabYoutube.addEventListener("click", () => setPlatform("youtube"));
  els.tabInstagram.addEventListener("click", () => setPlatform("instagram"));

  // sync notice visibility with the default active tab (YouTube) on load,
  // without resetting anything else yet
  els.youtubeNotice.hidden = state.platform !== "youtube";

  // ---------------- quality list ----------------

  function renderQualityOptions() {
    els.qualityList.innerHTML = "";
    QUALITY_OPTIONS.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quality__opt" + (opt.value === state.quality ? " is-selected" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(opt.value === state.quality));
      btn.dataset.value = opt.value;
      btn.innerHTML = `<span class="quality__radio"></span>${opt.label}`;
      btn.addEventListener("click", () => {
        state.quality = opt.value;
        renderQualityOptions();
      });
      els.qualityList.appendChild(btn);
    });
  }
  renderQualityOptions();

  // ---------------- status / reset ----------------

  function setStatus(message, isError = false) {
    els.statusLine.textContent = message || "";
    els.statusLine.classList.toggle("is-error", isError);
  }

  function resetResults() {
    els.preview.hidden = true;
    els.qualitySection.hidden = true;
    els.downloadBtn.hidden = true;
    els.pickerSection.hidden = true;
    els.pickerList.innerHTML = "";
    setStatus("");
  }

  // ---------------- fetch metadata ----------------

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = els.input.value.trim();
    if (!url) return;

    resetResults();
    state.currentUrl = url;
    els.fetchBtn.disabled = true;
    setStatus("Looking it up…");

    try {
      const res = await fetch(`/api/meta?url=${encodeURIComponent(url)}&platform=${state.platform}`);
      const data = await res.json();

      if (!res.ok) {
        setStatus(data.error || "Couldn't read that link.", true);
        return;
      }

      showPreview(data);
      setStatus("");

      if (state.platform === "youtube") {
        els.qualitySection.hidden = false;
      }
      els.downloadBtnLabel.textContent = "Download";
      els.downloadBtn.hidden = false;
    } catch {
      setStatus("Couldn't reach the server. Try again.", true);
    } finally {
      els.fetchBtn.disabled = false;
    }
  });

  function showPreview(data) {
    els.preview.hidden = false;
    els.previewTitle.textContent = data.title || "Video";
    els.previewAuthor.textContent = data.author || "";
    els.previewAuthor.hidden = !data.author;
    els.previewThumb.style.backgroundImage = data.thumbnail ? `url("${data.thumbnail}")` : "none";
  }

  // ---------------- download ----------------

  els.downloadBtn.addEventListener("click", async () => {
    if (!state.currentUrl) return;

    els.downloadBtn.disabled = true;
    els.downloadBtnLabel.textContent = "Preparing…";
    els.pickerSection.hidden = true;
    els.pickerList.innerHTML = "";
    setStatus("Talking to the extraction backend…");

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: state.currentUrl,
          platform: state.platform,
          quality: state.platform === "youtube" ? state.quality : "best",
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus(data.error || "Couldn't prepare that download.", true);
        return;
      }

      if (data.picker) {
        renderPicker(data.picker);
        setStatus("Multiple files found — pick one below.");
        return;
      }

      if (data.url) {
        triggerDownload(data.url, data.filename);
        setStatus("Download started.");
        return;
      }

      setStatus("Something unexpected happened. Try again.", true);
    } catch {
      setStatus("Couldn't reach the server. Try again.", true);
    } finally {
      els.downloadBtn.disabled = false;
      els.downloadBtnLabel.textContent = "Download";
    }
  });

  function renderPicker(items) {
    els.pickerSection.hidden = false;
    items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "picker__item";
      const name = `${sanitizeName(item.type)}_${i + 1}`;
      row.innerHTML = `<span>${item.type || "file"} ${i + 1}</span>`;
      const link = document.createElement("a");
      link.textContent = "Download";
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        triggerDownload(item.url, name);
      });
      row.appendChild(link);
      els.pickerList.appendChild(row);
    });
  }

  function sanitizeName(name) {
    return (name || "file").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function triggerDownload(url, filename) {
    const streamUrl = `/api/stream?u=${encodeURIComponent(url)}&name=${encodeURIComponent(
      filename || "download"
    )}`;
    const a = document.createElement("a");
    a.href = streamUrl;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
})();
