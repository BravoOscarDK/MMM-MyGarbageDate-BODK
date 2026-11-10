Module.register("MMM-MyGarbageDate-BODK", {
  text(key) {
    const texts = {
      "en": {
        "Waiting for calendar...": "Waiting for calendar...",
        "Last download": "Last download",
        "dates": "dates",
        "Latest update failed": "Latest update failed",
        "Calendar download failed": "Calendar download failed"
      },
      "da": {
        "Waiting for calendar...": "Venter på kalender...",
        "Last download": "Seneste download",
        "dates": "datoer",
        "Latest update failed": "Seneste opdatering mislykkedes",
        "Calendar download failed": "Download af kalender mislykkedes"
      }
    };
    const language = String(this.config.language || "en").toLowerCase().split(/[-_]/)[0];
    return (Object.hasOwn(texts, language) ? texts[language] : texts.en)[key] || texts.en[key] || key;
  },
  defaults: {
    language: "en",
    address: "",
    postalCode: "",
    expectedAddress: "",
    organizationId: "464debc4-4de1-4bc7-bd45-614c8eca81e9",
    year: null,
    pythonPath: "",
    outputFile: "../MMM-MyGarbage-BODK/garbage_schedule.csv",
    updateInterval: 24 * 60 * 60 * 1000,
    showStatus: true
  },

  start: function () {
    this.status = this.status || this.text("Waiting for calendar...");
    clearTimeout(this.timer);
    this.requestUpdate();
  },

  requestUpdate: function () {
    clearTimeout(this.timer);
    this.sendSocketNotification("MYGARBAGEDATE_UPDATE", { ...this.config, instanceId: this.identifier });
    const now = new Date();
    const interval = Math.max(60000, Number(this.config.updateInterval) || 86400000);
    const automaticYear = this.config.year == null || this.config.year === "auto";
    const untilNewYear = new Date(now.getFullYear() + 1, 0, 1).getTime() - now.getTime();
    // Re-evaluate the server year at midnight on January 1 without a restart.
    const delay = Math.min(interval, automaticYear ? untilNewYear : interval, 2147483647);
    this.timer = setTimeout(() => this.requestUpdate(), delay);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "MYGARBAGEDATE_STATUS" || payload.instanceId !== this.identifier) return;
    if (payload.ok) {
      const downloaded = new Date(payload.downloadedAt);
      const pad = (value) => String(value).padStart(2, "0");
      const timestamp = `${pad(downloaded.getDate())}/${pad(downloaded.getMonth() + 1)}/${downloaded.getFullYear()} ${pad(downloaded.getHours())}:${pad(downloaded.getMinutes())}`;
      this.lastSuccess = `${this.text("Last download")}: ${timestamp} | OK | ${payload.dateCount} ${this.text("dates")}`;
      this.status = this.lastSuccess;
    } else {
      this.status = this.lastSuccess ? this.lastSuccess + " | " + this.text("Latest update failed") : this.text("Calendar download failed");
    }
    if (this.config.showStatus) this.updateDom();
  },

  suspend: function () { clearTimeout(this.timer); },
  resume: function () { this.start(); },

  getDom: function () {
    const element = document.createElement("div");
    element.className = "small dimmed";
    if (this.config.showStatus) element.textContent = this.status;
    return element;
  }
});
