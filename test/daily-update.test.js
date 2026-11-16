const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

test("reuses today's successful update across restarts and retries when necessary", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garbage-date-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "schedule.csv");
  const metadata = path.join(dir, ".cache", crypto.createHash("sha256").update(output).digest("hex") + ".json");
  let calls = 0;
  let fail = false;
  const context = {
    module: { exports: {} }, __dirname: dir, process, Buffer, console,
    require(name) {
      if (name === "node_helper") return { create: (definition) => definition };
      if (name === "node:child_process") return { execFile(_python, _args, _options, callback) {
        calls++;
        if (fail) return callback(new Error("failed"), "", "failed");
        fs.writeFileSync(output, "valid schedule");
        callback(null, JSON.stringify({ dateCount: 42, downloadedAt: new Date().toISOString() }), "");
      } };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "node_helper.js"), "utf8"), context);
  const helper = context.module.exports;
  helper.path = dir;
  const reports = [];
  helper.sendSocketNotification = (_name, payload) => reports.push(payload);
  const config = { instanceId: "one", address: "Example Road 1", postalCode: "1234", expectedAddress: "", organizationId: "example", outputFile: output, pythonPath: "python", year: 2026 };
  const update = () => helper.socketNotificationReceived("MYGARBAGEDATE_UPDATE", config);
  helper.start();
  update();
  assert.equal(calls, 1);
  helper.start();
  update();
  assert.equal(calls, 1);
  assert.equal(reports.at(-1).dateCount, 42);
  fs.writeFileSync(output, "changed");
  update();
  assert.equal(calls, 2);
  config.address = "Example Road 2";
  update();
  assert.equal(calls, 3);
  const saved = JSON.parse(fs.readFileSync(metadata, "utf8"));
  saved.downloadedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metadata, JSON.stringify(saved));
  fail = true;
  update();
  assert.equal(reports.at(-1).ok, false);
  fail = false;
  update();
  assert.equal(calls, 5);
  assert.equal(reports.at(-1).ok, true);
  fs.unlinkSync(output);
  update();
  assert.equal(calls, 6);
});
