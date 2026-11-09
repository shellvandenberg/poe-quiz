import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { createRequire } from "module";

function loadPuppeteer() {
  const roots = ["/tmp/poe-test/package.json", "/workspace/package.json"];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try { return createRequire(root)("puppeteer-core"); }
    catch (e) { /* try the next install */ }
  }
  throw new Error("Install puppeteer-core (npm install puppeteer-core) to run this browser test.");
}
const puppeteer = loadPuppeteer();

const ROOT = path.resolve("/workspace");
const CHROME = "/usr/local/bin/google-chrome";
const SHOTS = "/tmp/poe-shots";
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
function ok(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error("FAIL", msg);
  } else console.log("ok", msg);
}

function contentType(file) {
  const ext = path.extname(file);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  };
  return types[ext] || "application/octet-stream";
}

function startServer() {
  let swOverride = null;
  const srv = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      if (urlPath === "/sw.js" && swOverride != null) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(swOverride);
        return;
      }
      const rel = urlPath.replace(/^\/+/, "");
      const file = path.resolve(ROOT, rel);
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end("no");
        return;
      }
      const data = fs.readFileSync(file);
      res.setHeader("Content-Type", contentType(file));
      res.setHeader("Cache-Control", "no-cache");
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end("missing");
    }
  });
  return new Promise(resolve => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        srv,
        base: `http://127.0.0.1:${port}/index.html`,
        origin: `http://127.0.0.1:${port}`,
        setSw: text => { swOverride = text; }
      });
    });
  });
}

const STUB_V29 = `const C="poe-quiz-v29",F=["./","./index.html","./POE_Quiz_singlefile.html","./manifest.json","./icon.svg","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(async c=>{await c.addAll(F); await c.put("marker-v29", new Response("old-cache"));}));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request)))});
`;

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-chrome-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: dir,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  return browser;
}

async function newPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.__errors = errors;
  return page;
}

async function card(page, id) {
  return page.$eval(`[data-section="${id}"]`, el => ({
    status: el.dataset.status,
    missed: el.dataset.missed,
    correct: el.dataset.correct,
    answered: el.dataset.answered,
    score: el.dataset.score || "",
    pos: el.dataset.pos,
    len: el.dataset.len,
    prior: el.dataset.prior || "",
    badge: el.querySelector(".badge").textContent.trim(),
    cls: el.className
  }));
}

async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, ...opts });
  console.log("shot", file);
}

function checkBank() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const single = fs.readFileSync(path.join(ROOT, "POE_Quiz_singlefile.html"), "utf8");
  ok(html === single, "one-file download matches index.html");
  const start = html.indexOf("const BANK = [");
  const end = html.indexOf("];\nconst LETTERS");
  const bank = eval(html.slice(start + "const BANK = ".length, end + 1));
  const hash = crypto.createHash("sha256").update(JSON.stringify(bank)).digest("hex");
  ok(bank.length === 381, "bank has 381 questions");
  ok(hash === "504735cfe6dc4faf24a1c847dbeb483521b447eb53b621a7cb9ed86817dd0cf4", "remaining question wording, answers, and citations match");
  const eboi = bank.find(b => b[1].includes("EBOI eastbound"));
  ok(eboi && eboi[1] === "A driver crosses the EBOI eastbound scale with a 10-axle combination that weighs 119,260 lbs. The truck is registered for 120,000 lbs and does not have a permit. Which code section would you use to cite operating without the required permit, and what permit does the combination need?" && eboi[2] === "I.C. 49-1004; an EL/EW permit up to 129,000 lbs" && eboi[3].join("|") === "I.C. 49-1010(3); a reducible oversize permit|I.C. 49-1001(3); an EL/EW permit|I.C. 49-1004(3); a 192,000 lbs permit" && eboi[4] === "Worksheet #23." && eboi[5] === "I.C. 49-1004(1); ITD POE Weight Worksheet p.8", "worksheet 23 stem has the scale context and the same answer");
  const cargo = bank.find(b => b[1].includes("not a truck tractor"));
  ok(cargo && cargo[1] === "Under Idaho Code 49-1010(7), a combination operating by permit on a route designated for an overall length of up to 115 feet consists of a truck (not a truck tractor) and two trailing units. What is the maximum cargo-carrying length allowed?" && cargo[2] === "98 feet" && cargo[3].join("|") === "95 feet|85 feet|115 feet" && cargo[4].startsWith("I.C. 49-1010(7)(c)") && cargo[4].includes("95 feet under I.C. 49-1010(7)(a) and (7)(b)") && cargo[4].includes("overall combination length, not the cargo-carrying length") && cargo[5] === "I.C. 49-1010(7)(c); ITD Extra Length/Excess Weight up to 129,000 lbs Route Chart (Dec 30, 2025) notes" && !/\bft\b/.test(cargo[4]), "the full-truck cargo length cites 49-1010(7)(c) and stays 98 feet");
  ok(bank.some(b => b[1] === "Under I.C. 49-1010(7), what is the maximum cargo-carrying length for a truck tractor with two or three trailing units?" && b[2] === "95 feet" && b[5] === "I.C. 49-1010(7)(a), (b)"), "the tractor cargo-length question is unchanged");
  ok(!bank.some(b => b[1].includes("full truck pulling two trailers")), "the old route-chart-only stem is gone");
  const arrows = bank.find(b => b[1].startsWith("As a general rule, combination packages"));
  ok(arrows && arrows[2] === "ORIENTATION ARROWS POINTING UP" && arrows[3].join("|") === "THIS END DOWN|KEEP UPRIGHT|DANGER" && arrows[4] === "Package orientation markings." && arrows[5] === "49 CFR 172.312(a); ITD POE Hazmat & Placards Worksheet p.2", "only the orientation-arrow choice is uppercased");
  const agency = bank.find(b => b[1] === "Which agency should you contact about hazmat out-of-service criteria?");
  ok(agency && agency[2] === "IDAHO STATE POLICE" && agency[3].join("|") === "FMCSA|EPA|ITD HQ" && agency[4] === "Contact ISP. Only ISP places vehicles out of service; POE inspectors park for repair." && agency[5] === "ITD DMV/POE Policy Manual, HazMat/Haz Waste SOP", "only the out-of-service agency choice is uppercased");
  ok((html.match(/Idaho State Police/g) || []).length === 6, "other Idaho State Police wording is unchanged");
  ok(!bank.some(b => b[1].includes("uniform hazardous waste manifest")), "the waste-PCB manifest question is gone");
  ok(!bank.some(b => b[1].includes("5,000 gallons of gasoline")), "the unmarked railroad gasoline question is gone");
  ok(!bank.some(b => b[1].includes("only transports hazmat")), "the carrier shipping-paper retention question is gone");
  ok(!bank.some(b => b[1].includes("Liquefied petroleum gas")), "the LPG cargo-tank question is gone");
  ok(!bank.some(b => b[1].includes("written incident report")), "the incident-report deadline question is gone");
  ok(!bank.some(b => b[1].includes("apply to hazmat carriers")), "the FMCSR hazmat-carrier question is gone");
  ok(!bank.some(b => b[1].includes("shipping papers in the cargo compartment")), "the cargo-compartment shipping-papers question is gone");
  ok(bank.some(b => b[1].includes("where must a driver keep the hazmat shipping papers")), "the other shipping-paper question stays");
  ok(!bank.some(b => b[1].includes("hazardous MATERIALS regulated under 49 CFR 171-172")), "the materials-credentials duplicate is gone");
  ok(bank.some(b => b[1].includes("placarded hazardous WASTES")), "the placarded-waste credentials question stays");
  ok(bank.some(b => b[1].includes("40 CFR 262 manifest")), "the manifest credentials question stays");
  ok(bank.some(b => b[1].includes("hazardous substances shown with an RQ")), "the RQ credentials question stays");
  ok(bank.some(b => b[1].startsWith("Waste PCBs at a concentration")), "the other PCB permit question stays");
  ok(!bank.some(b => /fire extinguisher rating is required|disc of what size|regrooved tire/.test(b[1])), "the three Equipment questions are gone");
  ok(bank.some(b => b[1].includes("Tinted windshields")) && bank.find(b => b[1].includes("Tinted windshields"))[2] === "70% of light", "the windshield tint question is unchanged");
  ok(bank.some(b => b[1].includes("Two 4 B:C") || b[2] === "Two 4 B:C extinguishers" || (b[3] || []).includes("Two 4 B:C extinguishers") || b[1].includes("5 B:C fire extinguisher")), "the other fire-extinguisher question stays");
  const utah = bank.find(b => b[1].includes("Idaho-Utah farm reciprocity"));
  ok(utah && utah[1] === "Under the Idaho-Utah farm reciprocity agreement, interstate farm reciprocity applies at what gross weight?" && utah[2] === "80,000 lbs or less" && utah[4].includes("intrastate operation in Idaho") && utah[4].includes("temporary permit or other valid interstate registration") && !/never/i.test(utah[4]), "full-fee wording says intrastate registration without banning every interstate trip");
  ok(!bank.some(b => b[1].includes("posted bridge limits or seasonal")), "the posted-bridge allowance question is gone");
  ok(bank.filter(b => b[5].includes("49-1011(3)") || b[1].includes("49-1011(3)")).length === 4, "the other 49-1011(3) allowance questions stay");
  ok(bank.filter(b => b[1].startsWith("A variable load suspension (VLS) axle is not deployed")).length === 2, "both undeployed VLS thresholds are asked");
  ok(bank.filter(b => b[4].includes("not the I.C. 49-1011(3) allowance")).length === 2, "the VLS threshold is not described as that allowance");
  const deployCode = bank.find(b => b[2] === "I.C. 49-1001(10)(e)");
  ok(deployCode && deployCode[5] === "I.C. 49-1001(10)(e); ITD DMV/POE Policy Manual 105.16" && deployCode[1].includes("Which current code applies") && deployCode[4].includes("fully deployed or fully raised") && deployCode[4].includes("older I.C. 49-1001(11)(e)"), "failure to deploy is keyed to current 49-1001(10)(e), with the manual's older 11(e) noted");
  ok(!bank.some(b => b[2].includes("49-1001(11)(e)") || b[5].includes("49-1001(11)(e)") || (b[3] || []).some(o => o.includes("49-1001(11)(e)"))), "49-1001(11)(e) is not offered as a current answer or citation");
  const deployed = bank.find(b => b[1].includes("axle is deployed. How is the group"));
  ok(deployed && deployed[2].includes("individually, or find the VLS axle weight by prequalification") && deployed[4].includes("One of those methods is used, not both"), "a deployed VLS axle is weighed individually or by prequalification, not both");
  ok(bank.filter(b => b[5] === "ITD DMV/POE Policy Manual 105.17").length === 2, "the air-suspension questions cite 105.17");
  ok(!bank.some(b => /VLS|10-foot spread/.test(b[1]) && b[5].includes("105.18")), "the new weighing questions do not use the cut-off 105.18 section");
  ok(bank.some(b => b[1].includes("Rule 18 and Rule 19")), "the existing Rule 18 question stays");
  ok(!/\bD3\b/.test(html), "no D3 name added");
  ok(html.includes("district supervisor"), "existing district wording kept");
  ok(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").includes('const C="poe-quiz-v30"'), "service worker cache is v30");
  const counts = {};
  bank.forEach(b => { counts[b[0]] = (counts[b[0]] || 0) + 1; });
  ok(counts.wt === 78 && counts.size === 67 && counts.haz === 41 && counts.sec === 30 && counts.eqp === 32 && counts.rov === 34 && counts.wim === 31 && counts.reg === 68, "Weight is 78 and every other section count is unchanged");
}

async function openHome(page, base) {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForSelector("#dash");
}

async function main() {
  checkBank();
  const server = await startServer();
  const browser = await launch();
  try {
    const page = await newPage(browser);
    await openHome(page, server.base);
    const spot = await page.evaluate(() => {
      const q = POE.ITEMS.find(it => it.q.startsWith("On the interstate, a tandem axle"));
      return {
        n: POE.ITEMS.length,
        ans: q.opts[q.ans],
        district: POE.ITEMS.some(it => it.opts.some(o => o.includes("district supervisor"))),
        d3: POE.ITEMS.some(it => (it.q + it.opts.join(" ") + it.expl + it.cite).includes("D3")),
        line: {
          p27: POE.passes(27, 30), p26: POE.passes(26, 30), p28: POE.passes(28, 30),
          p71: POE.passes(71, 78), p70: POE.passes(70, 78),
          p61: POE.passes(61, 67), p60: POE.passes(60, 67),
          p37: POE.passes(37, 41), p36: POE.passes(36, 41),
          p32: POE.passes(32, 35), p31: POE.passes(31, 35),
          e29: POE.passes(29, 32), e28: POE.passes(28, 32),
          r31: POE.passes(31, 34), r30: POE.passes(30, 34),
          w28: POE.passes(28, 31), w27: POE.passes(27, 31),
          g62: POE.passes(62, 68), g61: POE.passes(61, 68),
          pct27: POE.scorePct(27, 30), pct26: POE.scorePct(26, 30), pct70: POE.scorePct(70, 78), pct71: POE.scorePct(71, 78)
        }
      };
    });
    ok(spot.n === 381 && spot.ans === "34,000 lbs" && spot.district && !spot.d3, "loaded bank keeps lbs wording");
    ok(spot.line.p27 && !spot.line.p26 && spot.line.p28 && spot.line.p71 && !spot.line.p70 && spot.line.p61 && !spot.line.p60 && spot.line.p37 && !spot.line.p36 && spot.line.e29 && !spot.line.e28 && spot.line.r31 && !spot.line.r30 && spot.line.w28 && !spot.line.w27 && spot.line.g62 && !spot.line.g61, "90% uses an exact ratio for every section length");
    ok(spot.line.pct27 === "90.0%" && spot.line.pct26 === "86.6%" && spot.line.pct70 === "89.7%" && spot.line.pct71 === "91.0%", "a score under 90% is not displayed as 90%");

    async function putMisses(spec) {
      await page.evaluate(spec => {
        const sections = {};
        POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
        for (const id in spec) {
          const items = POE.ITEMS.filter(it => it.sec === id);
          const answers = {};
          items.forEach((it, i) => {
            answers[POE.QID(it)] = i < spec[id] ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
          });
          sections[id] = { shuffle: false, deck: items.map(POE.QID), pos: 0, answers, finished: true };
        }
        localStorage.setItem(POE.KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
      }, spec);
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("#dash");
    }
    await putMisses({ sec: 3, wt: 7, size: 7, haz: 4, eqp: 3, rov: 3, wim: 4, reg: 6 });
    const line = {};
    for (const id of ["sec", "wt", "size", "haz", "eqp", "rov", "wim", "reg"]) line[id] = await card(page, id);
    ok(line.sec.status === "pass" && line.sec.correct === "27" && line.sec.score === "90.0%" && line.sec.answered === "30", "27/30 is exactly 90% and passes");
    ok(line.wt.status === "pass" && line.wt.correct === "71" && line.wt.answered === "78" && line.wt.score === "91.0%", "71/78 passes and 70/78 does not");
    ok(line.size.status === "needs" && line.size.correct === "60" && line.size.score === "89.5%", "60/67 is below 90%");
    ok(line.haz.status === "pass" && line.haz.correct === "37", "37/41 passes");
    ok(line.eqp.status === "pass" && line.eqp.correct === "29" && line.eqp.answered === "32" && line.eqp.score === "90.6%", "29/32 is the Equipment pass line");
    ok(line.rov.status === "pass" && line.rov.correct === "31", "31/34 passes");
    ok(line.wim.status === "needs" && line.wim.correct === "27", "27/31 is below 90%");
    ok(line.reg.status === "pass" && line.reg.correct === "62", "62/68 passes");
    const secKept = await page.evaluate(() => Object.keys(POE.state().sections.sec.answers).length);
    await putMisses({ sec: 4 });
    const below = await card(page, "sec");
    ok(below.status === "needs" && below.correct === "26" && below.score === "86.6%" && below.answered === "30" && secKept === 30, "26/30 does not pass and the saved answers remain");
    await putMisses({ sec: 2 });
    const above = await card(page, "sec");
    ok(above.status === "pass" && above.correct === "28" && above.score === "93.3%", "28/30 passes");
    await page.evaluate(() => localStorage.clear());
    ok(page.__errors.length === 0, "home page has no script errors: " + page.__errors.join(" | "));

    const removed = ["haz:egde7o", "haz:1cig5l", "haz:1fa98sb", "haz:788p4", "haz:fme9xb", "haz:14cn7ir", "haz:d51sr7", "haz:1wb9lbe", "haz:15wpdls", "eqp:15u43op", "eqp:ky5ndd", "eqp:16h2u9", "wt:6pulef"];
    await page.evaluate(removedIds => {
      localStorage.clear();
      const wt = POE.ITEMS.filter(it => it.sec === "wt");
      const answers = {};
      wt.slice(0, 2).forEach(it => { answers[POE.QID(it)] = it.opts[it.ans]; });
      removedIds.forEach(id => { answers[id] = "saved answer"; });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "wt", shuffle: false, deck: [...removedIds, ...wt.map(POE.QID)], pos: 1, answers, finished: false, t: 1
      }));
    }, removed);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const fromOld = await page.evaluate(removedIds => ({
      present: removedIds.some(id => POE.ITEMS.some(it => POE.QID(it) === id)),
      wt: {
        len: POE.state().sections.wt.deck.length,
        pos: POE.state().sections.wt.pos,
        answered: Object.keys(POE.state().sections.wt.answers).length,
        hasRemoved: POE.state().sections.wt.deck.some(id => removedIds.includes(id))
      },
      rawDeck: POE.state().legacy && POE.state().legacy.raw && POE.state().legacy.raw.deck.slice(0, removedIds.length)
    }), removed);
    ok(!fromOld.present && !fromOld.wt.hasRemoved && fromOld.wt.len === 78 && fromOld.wt.pos === 1 && fromOld.wt.answered === 2 && JSON.stringify(fromOld.rawDeck) === JSON.stringify(removed), "an older save drops the removed questions, keeps Weight, and stores the original save (" + JSON.stringify(fromOld) + ")");
    const wtOld = await card(page, "wt");
    ok(wtOld.status === "progress" && wtOld.answered === "2" && wtOld.badge === "In progress", "the restored Weight quiz stays in progress");

    await page.evaluate(removedIds => {
      localStorage.clear();
      const haz = POE.ITEMS.filter(it => it.sec === "haz");
      const wt = POE.ITEMS.filter(it => it.sec === "wt");
      const keep = haz.slice(0, 5);
      const sections = {};
      POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      const hazAnswers = {};
      keep.slice(0, 3).forEach(it => { hazAnswers[POE.QID(it)] = it.opts[it.ans]; });
      removedIds.forEach(id => { hazAnswers[id] = "saved answer"; });
      sections.haz = { shuffle: false, deck: [POE.QID(keep[0]), ...removedIds, ...keep.slice(1).map(POE.QID)], pos: 2, answers: hazAnswers, finished: false };
      const wtAnswers = {};
      wt.slice(0, 4).forEach((it, i) => { wtAnswers[POE.QID(it)] = i === 0 ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans]; });
      sections.wt = { shuffle: false, deck: wt.map(POE.QID), pos: 6, answers: wtAnswers, finished: false };
      const mixedAnswers = { [POE.QID(keep[0])]: keep[0].opts[keep[0].ans] };
      removedIds.forEach(id => { mixedAnswers[id] = "saved answer"; });
      localStorage.setItem(POE.KEY, JSON.stringify({
        v: 2,
        sections,
        mixed: { shuffle: false, filter: "all", deck: [...removedIds, POE.QID(keep[0])], pos: 1, answers: mixedAnswers, finished: false },
        legacy: { raw: { deck: removedIds, pos: 0, answers: {}, finished: true }, placed: "kept", detail: "backup", dismissed: true }
      }));
    }, removed);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const orphan = await page.evaluate(removedIds => ({
      gone: !POE.ITEMS.some(it => /uniform hazardous waste manifest|5,000 gallons of gasoline|only transports hazmat|Liquefied petroleum gas|written incident report|apply to hazmat carriers|shipping papers in the cargo compartment|hazardous MATERIALS regulated under 49 CFR 171-172|nearest rail|fire extinguisher rating is required|disc of what size|regrooved tire|posted bridge limits or seasonal/.test(it.q)),
      hazDeck: POE.state().sections.haz.deck,
      hazHasRemoved: POE.state().sections.haz.deck.some(id => removedIds.includes(id)),
      hazPos: POE.state().sections.haz.pos,
      hazAnswers: Object.keys(POE.state().sections.haz.answers).length,
      wtPos: POE.state().sections.wt.pos,
      wtAnswered: Object.keys(POE.state().sections.wt.answers).length,
      wtLen: POE.state().sections.wt.deck.length,
      mixedDeck: POE.state().mixed.deck,
      mixedPos: POE.state().mixed.pos,
      legacyKept: !!(POE.state().legacy && POE.state().legacy.raw && JSON.stringify(POE.state().legacy.raw.deck) === JSON.stringify(removedIds))
    }), removed);
    ok(orphan.gone && !orphan.hazHasRemoved && orphan.hazDeck.length === 5 && orphan.hazPos === 2 && orphan.hazAnswers === 3, "a saved HazMat deck drops the removed questions and keeps the rest (" + JSON.stringify(orphan) + ")");
    ok(orphan.wtPos === 6 && orphan.wtAnswered === 4 && orphan.wtLen === 78, "Weight progress stays when the removed questions are dropped");
    ok(orphan.mixedDeck.length === 1 && !orphan.mixedDeck.some(id => removed.includes(id)) && orphan.mixedPos === 0 && orphan.legacyKept, "mixed progress drops the missing questions and the backup save is kept");
    ok((await card(page, "haz")).status === "progress" && (await card(page, "haz")).answered === "3", "HazMat stays in progress after the missing question is ignored");
    ok((await card(page, "wt")).pos === "6" && (await card(page, "wt")).answered === "4" && (await card(page, "wt")).missed === "1", "Weight still shows its saved place and miss");
    await page.click('[data-action="resume"][data-section="haz"]');
    await page.waitForSelector("h3");
    const resumed = await page.evaluate(() => ({ q: document.querySelector("h3").textContent, pos: document.querySelector("[data-pos]").dataset.pos }));
    const expectedQ = await page.evaluate(() => POE.ITEMS.filter(it => it.sec === "haz")[2].q);
    ok(resumed.pos === "2" && resumed.q === expectedQ, "HazMat resumes a saved question that is still in the bank");
    ok(page.__errors.length === 0, "dropping a removed saved question does not throw: " + page.__errors.join(" | "));
    await page.evaluate(oldIds => {
      localStorage.clear();
      const items = POE.ITEMS.filter(it => it.sec === "eqp");
      const answers = {};
      answers[POE.QID(items[2])] = items[2].opts[items[2].ans];
      oldIds.forEach(id => { answers[id] = "10 B:C"; });
      const sections = {};
      POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.eqp = { shuffle: false, deck: items.map(POE.QID).concat(oldIds), pos: 5, answers, finished: false };
      localStorage.setItem(POE.KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    }, ["eqp:15u43op", "eqp:ky5ndd", "eqp:16h2u9"]);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const eqpKept = await page.evaluate(oldIds => {
      const sess = POE.state().sections.eqp;
      const keptId = POE.QID(POE.ITEMS.filter(it => it.sec === "eqp")[2]);
      return { len: sess.deck.length, pos: sess.pos, kept: sess.answers[keptId], old: oldIds.some(id => sess.deck.includes(id) || sess.answers[id]) };
    }, ["eqp:15u43op", "eqp:ky5ndd", "eqp:16h2u9"]);
    ok(eqpKept.len === 32 && eqpKept.pos === 5 && !!eqpKept.kept && !eqpKept.old, "an Equipment save drops only the three removed questions and keeps the saved answer and place (" + JSON.stringify(eqpKept) + ")");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => localStorage.clear());

    await page.evaluate(() => {
      localStorage.clear();
      const it = POE.ITEMS.find(item => item.q.startsWith("As a general rule, combination packages"));
      const sections = {};
      POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      const haz = POE.ITEMS.filter(item => item.sec === "haz");
      const answers = {};
      haz.forEach(item => { answers[POE.QID(item)] = item.opts[item.ans]; });
      answers[POE.QID(it)] = "Orientation arrows pointing up";
      sections.haz = { shuffle: false, deck: haz.map(POE.QID), pos: haz.indexOf(it), answers, finished: false };
      const size = POE.ITEMS.filter(item => item.sec === "size");
      const sizeAnswers = {};
      size.slice(0, 2).forEach(item => { sizeAnswers[POE.QID(item)] = item.opts[item.ans]; });
      sections.size = { shuffle: false, deck: size.map(POE.QID), pos: 3, answers: sizeAnswers, finished: false };
      localStorage.setItem(POE.KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const arrows = await page.evaluate(() => {
      const it = POE.ITEMS.find(item => item.q.startsWith("As a general rule, combination packages"));
      const saved = POE.state().sections.haz.answers[POE.QID(it)];
      const g = POE.gradeSection("haz");
      return {
        correct: it.opts[it.ans],
        saved,
        status: g.status,
        missed: g.missed,
        answered: g.answered,
        pos: POE.state().sections.haz.pos,
        sizePos: POE.state().sections.size.pos,
        sizeAnswered: Object.keys(POE.state().sections.size.answers).length
      };
    });
    ok(arrows.correct === "ORIENTATION ARROWS POINTING UP" && arrows.saved === "ORIENTATION ARROWS POINTING UP" && arrows.status === "pass" && arrows.missed === 0 && arrows.answered === 41, "an older mixed-case orientation answer still counts as correct (" + JSON.stringify(arrows) + ")");
    ok(arrows.sizePos === 3 && arrows.sizeAnswered === 2, "the casing match leaves Size progress in place");
    await page.click('[data-action="resume"][data-section="haz"]');
    await page.waitForSelector("h3");
    const arrowView = await page.evaluate(() => {
      const chosen = [...document.querySelectorAll(".opt")].map(el => ({ text: el.textContent, ok: el.classList.contains("ok") }));
      return { q: document.querySelector("h3").textContent, chosen };
    });
    ok(arrowView.q.startsWith("As a general rule, combination packages") && arrowView.chosen.some(o => o.ok && o.text.includes("ORIENTATION ARROWS POINTING UP")) && !arrowView.chosen.some(o => o.text.includes("Orientation arrows pointing up")), "the saved answer shows the uppercase choice as correct");
    await page.evaluate(() => localStorage.clear());

    await page.evaluate(() => {
      localStorage.clear();
      const it = POE.ITEMS.find(item => item.q === "Which agency should you contact about hazmat out-of-service criteria?");
      const sections = {};
      POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      const haz = POE.ITEMS.filter(item => item.sec === "haz");
      const answers = {};
      haz.forEach(item => { answers[POE.QID(item)] = item.opts[item.ans]; });
      answers[POE.QID(it)] = "Idaho State Police";
      sections.haz = { shuffle: false, deck: haz.map(POE.QID), pos: haz.indexOf(it), answers, finished: false };
      const wt = POE.ITEMS.filter(item => item.sec === "wt");
      const wtAnswers = {};
      wt.slice(0, 3).forEach((item, i) => { wtAnswers[POE.QID(item)] = i === 0 ? item.opts.find((_, k) => k !== item.ans) : item.opts[item.ans]; });
      sections.wt = { shuffle: false, deck: wt.map(POE.QID), pos: 4, answers: wtAnswers, finished: false };
      localStorage.setItem(POE.KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const agency = await page.evaluate(() => {
      const it = POE.ITEMS.find(item => item.q === "Which agency should you contact about hazmat out-of-service criteria?");
      const g = POE.gradeSection("haz");
      return {
        stem: it.q,
        correct: it.opts[it.ans],
        choices: it.opts.slice().sort().join("|"),
        expl: it.expl,
        cite: it.cite,
        saved: POE.state().sections.haz.answers[POE.QID(it)],
        status: g.status,
        missed: g.missed,
        answered: g.answered,
        pos: POE.state().sections.haz.pos,
        wtPos: POE.state().sections.wt.pos,
        wtAnswered: Object.keys(POE.state().sections.wt.answers).length,
        wtMissed: POE.gradeSection("wt").missed
      };
    });
    ok(agency.stem === "Which agency should you contact about hazmat out-of-service criteria?" && agency.correct === "IDAHO STATE POLICE" && agency.choices === "EPA|FMCSA|IDAHO STATE POLICE|ITD HQ" && agency.expl.startsWith("Contact ISP.") && agency.cite.includes("HazMat/Haz Waste SOP"), "the out-of-service question keeps its stem, explanation, and citation");
    ok(agency.saved === "IDAHO STATE POLICE" && agency.status === "pass" && agency.missed === 0 && agency.answered === 41, "an older Idaho State Police answer still counts as correct (" + JSON.stringify(agency) + ")");
    ok(agency.wtPos === 4 && agency.wtAnswered === 3 && agency.wtMissed === 1, "the casing match leaves Weight progress in place");
    await page.click('[data-action="resume"][data-section="haz"]');
    await page.waitForSelector("h3");
    const agencyView = await page.evaluate(() => ({
      q: document.querySelector("h3").textContent,
      marked: [...document.querySelectorAll(".opt.ok")].map(el => el.textContent)
    }));
    ok(agencyView.q === "Which agency should you contact about hazmat out-of-service criteria?" && agencyView.marked.some(t => t.includes("IDAHO STATE POLICE")) && !agencyView.marked.some(t => t.includes("Idaho State Police")), "the saved agency answer shows the uppercase choice as correct");
    await page.evaluate(() => localStorage.clear());

    await page.evaluate(oldId => {
      localStorage.clear();
      const wt = POE.ITEMS.filter(it => it.sec === "wt");
      const target = wt.find(it => it.q.includes("EBOI eastbound"));
      const idx = wt.indexOf(target);
      const deck = wt.map(POE.QID);
      deck[idx] = oldId;
      const answers = {};
      answers[oldId] = "I.C. 49-1004; an EL/EW permit up to 129,000 lbs";
      wt.slice(0, 2).forEach(it => { if (it !== target) answers[POE.QID(it)] = it.opts[it.ans]; });
      const sections = {};
      POE.SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.wt = { shuffle: false, deck, pos: idx, answers, finished: false };
      const size = POE.ITEMS.filter(it => it.sec === "size");
      const sizeAnswers = {};
      size.slice(0, 2).forEach(it => { sizeAnswers[POE.QID(it)] = it.opts[it.ans]; });
      sections.size = { shuffle: false, deck: size.map(POE.QID), pos: 3, answers: sizeAnswers, finished: false };
      localStorage.setItem(POE.KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    }, "wt:11lfube");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const moved = await page.evaluate(oldId => {
      const it = POE.ITEMS.find(item => item.q.includes("EBOI eastbound"));
      const id = POE.QID(it);
      const sess = POE.state().sections.wt;
      const g = POE.gradeSection("wt");
      return {
        q: it.q,
        ans: it.opts[it.ans],
        cite: it.cite,
        inDeck: sess.deck.includes(id),
        oldInDeck: sess.deck.includes(oldId),
        saved: sess.answers[id],
        pos: sess.pos,
        correct: g.correct,
        sizePos: POE.state().sections.size.pos,
        sizeAnswered: Object.keys(POE.state().sections.size.answers).length
      };
    }, "wt:11lfube");
    ok(moved.q.includes("operating without the required permit") && moved.q.includes("EBOI eastbound scale") && moved.ans === "I.C. 49-1004; an EL/EW permit up to 129,000 lbs" && moved.cite === "I.C. 49-1004(1); ITD POE Weight Worksheet p.8", "the rewritten question keeps the permit answer and citation");
    ok(moved.inDeck && !moved.oldInDeck && moved.saved === moved.ans && moved.pos > 0 && moved.correct >= 1, "a save under the old question wording still counts on the new stem (" + JSON.stringify(moved) + ")");
    ok(moved.sizePos === 3 && moved.sizeAnswered === 2, "the stem migration leaves Size progress in place");
    await page.click('[data-action="resume"][data-section="wt"]');
    await page.waitForSelector("h3");
    const eboiView = await page.evaluate(() => ({
      q: document.querySelector("h3").textContent,
      marked: [...document.querySelectorAll(".opt.ok")].map(el => el.textContent).join(" ")
    }));
    ok(eboiView.q.includes("EBOI eastbound scale") && eboiView.q.includes("operating without the required permit") && eboiView.marked.includes("I.C. 49-1004; an EL/EW permit up to 129,000 lbs"), "resume opens the rewritten question with the saved permit answer marked");
    await page.evaluate(() => localStorage.clear());

    const addedIds = ["wt:1tv2nsn", "wt:1jrg7pf", "wt:1c9d28q", "wt:779bej", "wt:lq1k8w", "wt:1q13yda", "wt:jkv47b", "wt:edenc4"];
    await page.evaluate(addedIds => {
      const { QID, ITEMS, SECTIONS, KEY } = POE;
      const added = new Set(addedIds);
      const old = ITEMS.filter(it => it.sec === "wt" && !added.has(QID(it)));
      const answers = {};
      old.forEach(it => { answers[QID(it)] = it.opts[it.ans]; });
      const haz = ITEMS.filter(it => it.sec === "haz").slice(0, 3);
      const hazAnswers = {};
      hazAnswers[QID(haz[0])] = haz[0].opts[haz[0].ans];
      const sections = {};
      SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.wt = { shuffle: false, deck: old.map(QID), pos: 4, answers, finished: true };
      sections.haz = { shuffle: false, deck: haz.map(QID), pos: 1, answers: hazAnswers, finished: false };
      localStorage.setItem(KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    }, addedIds);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const grown = await card(page, "wt");
    const hazKept = await card(page, "haz");
    ok(grown.status === "progress" && grown.badge === "In progress" && grown.len === "78" && grown.answered === "70" && grown.correct === "70" && grown.pos === "70" && !grown.cls.includes("pass"), "a finished 70-question Weight save gains the new questions and does not stay PASS");
    ok(hazKept.status === "progress" && hazKept.len === "3" && hazKept.pos === "1" && hazKept.answered === "1", "a short HazMat save is not filled with the new Weight questions");
    const boundary = await page.evaluate(() => {
      const sess = POE.state().sections.wt;
      const byId = new Map(POE.ITEMS.map(it => [POE.QID(it), it]));
      sess.deck.forEach(id => {
        if (sess.answers[id]) return;
        const it = byId.get(id);
        sess.answers[id] = it.opts.find((_, k) => k !== it.ans);
      });
      sess.finished = true;
      const low = POE.gradeSection("wt");
      const flip = byId.get("wt:1tv2nsn");
      sess.answers[flip && POE.QID(flip)] = flip.opts[flip.ans];
      const high = POE.gradeSection("wt");
      return {
        low: low.status + " " + low.correct + "/" + low.deck.length,
        high: high.status + " " + high.correct + "/" + high.deck.length
      };
    });
    ok(boundary.low === "needs 70/78" && boundary.high === "pass 71/78", "70/78 is below 90% and 71/78 passes (" + JSON.stringify(boundary) + ")");
    await page.evaluate(addedIds => {
      const { QID, ITEMS, SECTIONS, KEY } = POE;
      const added = new Set(addedIds);
      const old = ITEMS.filter(it => it.sec === "wt" && !added.has(QID(it))).slice(0, 4);
      const answers = {};
      answers[QID(old[0])] = old[0].opts[old[0].ans];
      const sections = {};
      SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.wt = { shuffle: false, deck: old.map(QID), pos: 2, answers, finished: false };
      localStorage.setItem(KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    }, addedIds);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const partialWt = await card(page, "wt");
    ok(partialWt.status === "progress" && partialWt.len === "4" && partialWt.pos === "2" && partialWt.answered === "1" && partialWt.badge === "In progress", "a partial Weight save keeps its place and is not expanded or passed");
    await page.evaluate(addedIds => {
      const { QID, ITEMS, KEY, KEY_V1 } = POE;
      const added = new Set(addedIds);
      const old = ITEMS.filter(it => it.sec === "wt" && !added.has(QID(it)));
      const answers = {};
      old.forEach(it => { answers[QID(it)] = it.opts[it.ans]; });
      localStorage.removeItem(KEY);
      localStorage.setItem(KEY_V1, JSON.stringify({ filter: "wt", shuffle: false, deck: old.map(QID), pos: 9, answers, finished: true, t: 1 }));
    }, addedIds);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-legacy-banner]");
    const legacyGrown = await card(page, "wt");
    const legacyBanner = await page.$eval("[data-legacy-banner]", el => el.textContent);
    ok(legacyGrown.status === "progress" && legacyGrown.badge === "In progress" && legacyGrown.len === "78" && legacyGrown.answered === "70" && legacyGrown.pos === "70" && !legacyGrown.cls.includes("pass"), "an older finished Weight quiz is restored in progress, not PASS");
    ok(legacyBanner.includes("New questions were added") && legacyBanner.includes("not passed") && legacyBanner.includes("question 71 of 78"), "the note says the added Weight questions are not a pass");
    await page.click('[data-action="resume"][data-section="wt"]');
    await page.waitForSelector("h3");
    const resumedNew = await page.$eval("h3", el => el.textContent);
    ok(resumedNew.includes("2,000 lbs or less") && resumedNew.includes("not deployed"), "resume opens the first added VLS question");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const { QID, ITEMS, KEY_V1 } = POE;
      const few = ITEMS.filter(it => it.sec === "wt").slice(0, 4);
      const answers = {};
      few.forEach(it => { answers[QID(it)] = it.opts[it.ans]; });
      localStorage.setItem(KEY_V1, JSON.stringify({ filter: "wt", shuffle: false, deck: few.map(QID), pos: 1, answers, finished: true, t: 2 }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#mixed");
    const shortLegacy = await card(page, "wt");
    const shortMixed = await card(page, "mixed");
    ok(shortLegacy.status === "new" && shortMixed.len === "4" && shortMixed.badge === "Finished", "a short older Weight save stays on the mixed quiz and does not pass Weight");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const { SECTIONS, KEY } = POE;
      const sections = {};
      SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.wt = { shuffle: false, deck: ["wt:p8dfzv"], pos: 0, answers: { "wt:p8dfzv": "I.C. 49-1001(11)(e)" }, finished: true };
      localStorage.setItem(KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const codeMove = await page.evaluate(() => {
      const sess = POE.state().sections.wt;
      const it = POE.ITEMS.find(x => x.q.includes("Which current code applies"));
      const id = POE.QID(it);
      return {
        id, inDeck: sess.deck.includes(id), oldInDeck: sess.deck.includes("wt:p8dfzv"),
        saved: sess.answers[id], correct: it.opts[it.ans], cite: it.cite,
        ansIndex: it.ans
      };
    });
    ok(codeMove.id === "wt:1jrg7pf" && codeMove.inDeck && !codeMove.oldInDeck && codeMove.saved === "I.C. 49-1001(10)(e)" && codeMove.correct === "I.C. 49-1001(10)(e)" && codeMove.cite === "I.C. 49-1001(10)(e); ITD DMV/POE Policy Manual 105.16", "an older 49-1001(11)(e) choice is kept as the current 49-1001(10)(e) answer (" + JSON.stringify(codeMove) + ")");
    await page.click('[data-action="resume"][data-section="wt"]');
    await page.waitForSelector(".opt.ok");
    const markedCode = await page.$eval(".opt.ok", el => el.textContent);
    ok(markedCode.includes("I.C. 49-1001(10)(e)") && !markedCode.includes("49-1001(11)(e)"), "resume marks the current 49-1001(10)(e) choice correct");
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(oldId => {
      const { QID, ITEMS, SECTIONS, KEY } = POE;
      const size = ITEMS.filter(it => it.sec === "size");
      const target = size.find(it => it.q.includes("not a truck tractor"));
      const idx = size.indexOf(target);
      const deck = size.map(QID);
      deck[idx] = oldId;
      const answers = {};
      answers[oldId] = "98 feet";
      const sections = {};
      SECTIONS.forEach(s => { sections[s.id] = { shuffle: false, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.size = { shuffle: false, deck, pos: idx, answers, finished: false };
      localStorage.setItem(KEY, JSON.stringify({ v: 2, sections, mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false }, legacy: null }));
    }, "size:14grbkc");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const cargoMove = await page.evaluate(oldId => {
      const it = POE.ITEMS.find(item => item.q.includes("not a truck tractor"));
      const id = POE.QID(it);
      const sess = POE.state().sections.size;
      const g = POE.gradeSection("size");
      const expectedPos = POE.ITEMS.filter(it => it.sec === "size").findIndex(item => item.q.includes("not a truck tractor"));
      return { id, inDeck: sess.deck.includes(id), oldInDeck: sess.deck.includes(oldId), saved: sess.answers[id], correct: g.correct, answered: g.answered, pos: sess.pos, expectedPos };
    }, "size:14grbkc");
    ok(cargoMove.id === "size:ztsjt2" && cargoMove.inDeck && !cargoMove.oldInDeck && cargoMove.saved === "98 feet" && cargoMove.correct === 1 && cargoMove.answered === 1 && cargoMove.pos === cargoMove.expectedPos, "a save under the old cargo-length wording still counts as 98 feet (" + JSON.stringify(cargoMove) + ")");
    await page.click('[data-action="resume"][data-section="size"]');
    await page.waitForSelector("h3");
    const cargoView = await page.evaluate(() => ({
      q: document.querySelector("h3").textContent,
      marked: [...document.querySelectorAll(".opt.ok")].map(el => el.textContent).join(" ")
    }));
    ok(cargoView.q.includes("Idaho Code 49-1010(7)") && cargoView.q.includes("not a truck tractor") && cargoView.marked.includes("98 feet"), "resume opens the rewritten cargo-length question with 98 feet marked");
    await page.evaluate(() => localStorage.clear());

    await page.evaluate(() => {
      const { QID, ITEMS, SECTIONS, KEY } = POE;
      function sess(id, miss, leave) {
        const items = ITEMS.filter(it => it.sec === id);
        const answers = {};
        items.forEach((it, i) => {
          if (i >= items.length - leave) return;
          const pick = i < miss ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
          answers[QID(it)] = pick;
        });
        return { shuffle: false, deck: items.map(QID), pos: 0, answers, finished: true };
      }
      const sections = {};
      SECTIONS.forEach(s => { sections[s.id] = { shuffle: true, deck: [], pos: 0, answers: {}, finished: false }; });
      sections.wt = sess("wt", 2, 0);
      sections.size = sess("size", 7, 0);
      sections.haz = sess("haz", 0, ITEMS.filter(it => it.sec === "haz").length - 10);
      sections.haz.pos = 5;
      sections.sec = sess("sec", 1, 0);
      sections.eqp = sess("eqp", 0, 0);
      sections.rov = sess("rov", 4, 10);
      sections.rov.pos = 20;
      sections.wim = sess("wim", 0, 1);
      sections.wim.pos = sections.wim.deck.length - 1;
      sections.reg = sess("reg", 7, 1);
      sections.reg.pos = sections.reg.deck.length - 1;
      localStorage.setItem(KEY, JSON.stringify({
        v: 2, sections,
        mixed: { shuffle: true, filter: "all", deck: [], pos: 0, answers: {}, finished: false },
        legacy: null, t: 1
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");

    const wt = await card(page, "wt");
    const size = await card(page, "size");
    const haz = await card(page, "haz");
    const sec = await card(page, "sec");
    const eqp = await card(page, "eqp");
    const rov = await card(page, "rov");
    const wim = await card(page, "wim");
    const reg = await card(page, "reg");
    ok(wt.status === "pass" && wt.badge === "PASS" && wt.missed === "2" && wt.answered === "78" && wt.correct === "76" && wt.score === "97.4%", "a finished Weight score of 76/78 stays PASS");
    ok(size.status === "needs" && size.badge === "NEEDS WORK" && size.missed === "7" && size.answered === "67" && size.correct === "60" && size.score === "89.5%" && size.cls.includes("needs"), "60/67 is below 90% and is NEEDS WORK");
    ok(sec.status === "pass" && sec.missed === "1" && sec.badge === "PASS", "1 missed is PASS");
    ok(eqp.status === "pass" && eqp.missed === "0" && eqp.badge === "PASS", "0 missed is PASS");
    ok(haz.status === "progress" && haz.badge === "In progress" && haz.missed === "0" && haz.answered === "10" && haz.pos === "5" && !haz.cls.includes("pass"), "unfinished section with no misses stays In progress");
    const hazFinished = await page.evaluate(() => POE.state().sections.haz.finished);
    ok(hazFinished === false, "a saved finished flag does not pass a section that still has unanswered questions");
    ok(rov.status === "progress" && rov.badge === "In progress" && rov.missed === "4" && rov.pos === "20" && rov.cls.includes("watch") && !rov.cls.includes("needs"), "an in-progress Rover quiz that cannot reach 90% is watched, not failed");
    ok(wim.status === "progress" && wim.badge === "In progress" && wim.missed === "0" && wim.answered === "30", "one question left is still In progress");
    ok(reg.status === "progress" && reg.badge === "In progress" && reg.missed === "7" && reg.cls.includes("watch"), "Registration stays In progress while one question remains, even though 90% is already out of reach");
    const attention = await page.$eval("[data-attention]", el => ({ kind: el.dataset.attention, text: el.textContent }));
    ok(attention.kind === "needs" && attention.text.includes("Size") && attention.text.includes("89.5%") && attention.text.includes("90%") && attention.text.includes("Rover") && attention.text.includes("Registration"), "dashboard names finished sections below 90% and unfinished sections that can no longer reach 90%");
    const names = await page.$$eval("#dash article h3", els => els.map(el => el.textContent.replace(/\s+/g, " ").trim()));
    ok(names.join(" | ") === "Weight | Size | HazMat | Securement | Equipment | Rover Roving POE | WIM/bypass | Registration", "home lists the eight section quizzes: " + names.join(" | "));

    await shot(page, "dashboard_grades.png", { fullPage: true });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await shot(page, "dashboard_mobile.png");
    await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });

    const rovQ = await page.evaluate(() => POE.ITEMS.filter(it => it.sec === "rov")[20].q);
    await page.click('[data-action="resume"][data-section="rov"]');
    await page.waitForSelector("h3");
    const rovNow = await page.evaluate(() => ({
      pos: document.querySelector("[data-pos]").dataset.pos,
      q: document.querySelector("h3").textContent
    }));
    ok(rovNow.pos === "20" && rovNow.q === rovQ, "Rover resumes the saved question");
    await page.click('[data-action="home"]');
    await page.waitForSelector("#dash");

    const hazQ = await page.evaluate(() => POE.ITEMS.filter(it => it.sec === "haz")[5].q);
    await page.click('[data-action="resume"][data-section="haz"]');
    await page.waitForSelector("[data-pos]");
    const hazNow = await page.evaluate(() => ({
      pos: document.querySelector("[data-pos]").dataset.pos,
      q: document.querySelector("h3").textContent,
      active: document.querySelector("[data-pos]").dataset.active
    }));
    ok(hazNow.pos === "5" && hazNow.q === hazQ && hazNow.active === "haz", "HazMat resumes its own place after Rover");

    const endSeparated = await page.evaluate(() => {
      const endBtn = document.querySelector(".endbtn");
      const nav = [...document.querySelectorAll(".row")].find(r => r.textContent.includes("Previous"));
      const style = getComputedStyle(endBtn);
      return {
        parent: endBtn.parentElement.className,
        inNav: nav.contains(endBtn),
        color: style.color,
        bg: style.backgroundColor
      };
    });
    ok(endSeparated.parent === "endrow" && endSeparated.inNav === false, "End test sits apart from Previous and Next");
    ok(endSeparated.color === "rgb(192, 57, 43)", "End test control stays red");
    await page.click('[data-action="end"]');
    await page.waitForSelector(".co.danger");
    const confirm = await page.evaluate(() => {
      const box = document.querySelector(".co.danger");
      const nav = [...document.querySelectorAll(".row")].find(r => r.textContent.includes("Previous"));
      const yes = box.querySelector(".dangerbtn");
      return {
        text: box.textContent,
        inNav: nav.contains(box),
        yesBg: getComputedStyle(yes).backgroundColor,
        endGone: !document.querySelector(".endbtn")
      };
    });
    ok(confirm.text.includes("End test now? Your progress is saved.") && confirm.text.includes("In progress") && confirm.text.includes("will not show PASS"), "end confirmation says an unfinished quiz is not a pass");
    ok(confirm.inNav === false && confirm.yesBg === "rgb(192, 57, 43)", "end confirmation is the separate red block");
    await shot(page, "end_test_confirmation.png");
    const posDuring = await page.$eval("[data-pos]", el => el.dataset.pos);
    await page.click('[data-action="end-stay"]');
    ok(await page.$eval("[data-pos]", el => el.dataset.pos) === posDuring && !(await page.$(".co.danger")), "Keep going stays on the same question");
    await page.click('[data-action="end"]');
    await page.click('[data-action="end-yes"]');
    await page.waitForSelector("#dash");
    const hazAfterEnd = await card(page, "haz");
    ok(hazAfterEnd.status === "progress" && hazAfterEnd.badge === "In progress" && hazAfterEnd.pos === "5" && hazAfterEnd.answered === "10", "ending an unfinished section leaves it In progress at the same place");
    ok((await card(page, "size")).status === "needs" && (await card(page, "wt")).status === "pass", "ending HazMat does not regrade other sections");

    await page.click('[data-action="restart"][data-section="haz"]');
    await page.waitForSelector('[data-confirm="restart"][data-section="haz"]');
    const restartText = await page.$eval('[data-confirm="restart"]', el => el.textContent);
    ok(restartText.includes("Restart HazMat only?") && restartText.includes("other sections stay"), "restart confirmation names only HazMat");
    await shot(page, "restart_one_section.png");
    await page.click('[data-action="restart-no"]');
    ok((await card(page, "haz")).answered === "10", "cancel restart keeps HazMat answers");
    await page.click('[data-action="restart"][data-section="haz"]');
    await page.click('[data-action="restart-yes"]');
    const hazReset = await card(page, "haz");
    ok(hazReset.status === "new" && hazReset.len === "0" && hazReset.badge === "Not started", "confirmed restart clears HazMat");
    ok((await card(page, "size")).missed === "7" && (await card(page, "size")).status === "needs", "Size grade survives a HazMat restart");
    ok((await card(page, "rov")).pos === "20" && (await card(page, "rov")).missed === "4", "Rover place survives a HazMat restart");
    ok((await card(page, "wt")).status === "pass" && (await card(page, "wim")).answered === "30", "Weight and WIM/bypass survive a HazMat restart");

    await page.click('[data-action="review"][data-section="size"]');
    await page.waitForSelector('[data-grade="needs"]');
    const review = await page.evaluate(() => {
      const g = POE.gradeSection("size");
      const blocks = [...document.querySelectorAll(".miss")];
      const all = g.missedItems.every(({ it, chosen }) => {
        const el = document.querySelector(`[data-review="${CSS.escape(POE.QID(it))}"]`);
        if (!el) return false;
        const text = el.textContent;
        return text.includes(it.opts[it.ans]) && text.includes(it.opts[chosen]) && text.includes(it.cite) && text.includes(it.expl);
      });
      return { n: blocks.length, missed: g.missed, all, grade: document.querySelector("[data-grade]").dataset.grade };
    });
    ok(review.grade === "needs" && review.n === 7 && review.missed === 7 && review.all, "missed Size questions show the chosen answer, correct answer, explanation, and citation");
    await shot(page, "review_missed.png");
    await page.click('[data-action="home"]');

    await page.click('[data-action="resume"][data-section="wim"]');
    await page.waitForSelector("[data-pick]");
    await page.evaluate(() => {
      const qid = document.querySelector("h3").dataset.qid;
      const it = POE.ITEMS.find(item => POE.QID(item) === qid);
      document.querySelector(`[data-action="pick"][data-pick="${it.ans}"]`).click();
    });
    await page.waitForSelector('[data-grade="pass"]');
    await page.click('[data-action="home"]');
    const wimDone = await card(page, "wim");
    ok(wimDone.status === "pass" && wimDone.badge === "PASS" && wimDone.missed === "0" && wimDone.answered === "31", "answering the last WIM/bypass question with 0 misses becomes PASS");

    await page.click('[data-action="resume"][data-section="reg"]');
    await page.waitForSelector("[data-pick]");
    await page.evaluate(() => {
      const qid = document.querySelector("h3").dataset.qid;
      const it = POE.ITEMS.find(item => POE.QID(item) === qid);
      document.querySelector(`[data-action="pick"][data-pick="${it.ans}"]`).click();
    });
    await page.waitForSelector('[data-grade="needs"]');
    await page.click('[data-action="home"]');
    const regDone = await card(page, "reg");
    ok(regDone.status === "needs" && regDone.badge === "NEEDS WORK" && regDone.missed === "7" && regDone.answered === "68" && regDone.score === "89.7%", "finishing Registration at 61/68 is below 90% and becomes NEEDS WORK");
    ok((await card(page, "wim")).status === "pass", "finishing Registration leaves the WIM/bypass pass in place");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS.filter(it => it.sec === "wt");
      const answers = {};
      items.slice(0, 4).forEach(it => {
        let text = it.opts[it.ans];
        if (!Object.keys(answers).length && text.includes("lbs")) text = text.replace(/\blbs\b/g, "lb");
        answers[POE.QID(it)] = text;
      });
      const raw = { filter: "wt", shuffle: false, deck: items.map(POE.QID), pos: 10, answers, finished: false, t: 99 };
      localStorage.setItem(POE.KEY_V1, JSON.stringify(raw));
      window.__raw = raw;
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-legacy-banner]");
    const legacy = await card(page, "wt");
    const banner = await page.$eval("[data-legacy-banner]", el => el.textContent);
    const legacyStore = await page.evaluate(() => ({
      v1: localStorage.getItem(POE.KEY_V1),
      arch: JSON.parse(localStorage.getItem(POE.KEY_V1_ARCH)),
      raw: POE.state().legacy.raw,
      size: POE.state().sections.size.deck.length,
      placed: POE.state().legacy.placed
    }));
    ok(legacy.status === "progress" && legacy.badge === "In progress" && legacy.pos === "10" && legacy.answered === "4" && legacy.correct === "4" && legacy.len === "78", "a saved full Weight quiz restores its place and lbs answers");
    ok(banner.includes("Weight") && banner.includes("question 11 of 78") && banner.includes("4 answered"), "migration tells you where the old quiz was restored");
    ok(legacyStore.v1 === null && legacyStore.placed === "wt" && legacyStore.size === 0, "old key is retired only after the backup exists, and other sections stay empty");
    ok(JSON.stringify(legacyStore.arch.deck) === JSON.stringify(legacyStore.raw.deck) && legacyStore.arch.pos === 10 && Object.keys(legacyStore.arch.answers).length === 4, "original save is kept in the backup and in the new record");
    ok((await card(page, "size")).status === "new" && (await card(page, "size")).badge === "Not started", "restoring Weight does not mark Size");
    await shot(page, "legacy_weight_restored.png", { fullPage: false });
    const archBefore = legacyStore.arch;
    await page.click('[data-action="restart"][data-section="wt"]');
    await page.click('[data-action="restart-yes"]');
    const afterRestart = await page.evaluate(() => ({
      arch: JSON.parse(localStorage.getItem(POE.KEY_V1_ARCH)),
      rawDeck: POE.state().legacy.raw.deck.length,
      wt: POE.state().sections.wt.deck.length
    }));
    ok((await card(page, "wt")).status === "new" && afterRestart.wt === 0, "restart clears only the Weight quiz");
    ok(JSON.stringify(afterRestart.arch.deck) === JSON.stringify(archBefore.deck) && afterRestart.rawDeck === 78, "restart does not erase the backed-up save");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS.filter(it => it.sec === "size");
      const answers = {};
      items.forEach((it, i) => {
        const pick = i < 3 ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
        answers[POE.QID(it)] = pick;
      });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "size", shuffle: false, deck: items.map(POE.QID), pos: 4, answers, finished: true, t: 5
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const sizeLegacy = await card(page, "size");
    ok(sizeLegacy.status === "pass" && sizeLegacy.badge === "PASS" && sizeLegacy.missed === "3" && sizeLegacy.answered === "67" && sizeLegacy.correct === "64" && sizeLegacy.score === "95.5%", "a finished Size quiz with 3 misses is regraded as PASS and the answers stay");
    ok((await card(page, "wt")).status === "new", "that Size migration does not fill Weight");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS.filter(it => it.sec === "eqp");
      const answers = {};
      items.forEach((it, i) => {
        if (i < 2) return;
        answers[POE.QID(it)] = i < 4 ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
      });
      // 2 misses, all answered
      items.forEach((it, i) => {
        answers[POE.QID(it)] = i < 2 ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
      });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "eqp", shuffle: false, deck: items.map(POE.QID), pos: 1, answers, finished: false, t: 6
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const eqpLegacy = await card(page, "eqp");
    ok(eqpLegacy.status === "pass" && eqpLegacy.badge === "PASS" && eqpLegacy.missed === "2" && eqpLegacy.answered === "32", "a fully answered saved Equipment quiz with 2 misses migrates as PASS");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const wt = POE.ITEMS.filter(it => it.sec === "wt").slice(0, 3);
      const sizeItems = POE.ITEMS.filter(it => it.sec === "size").slice(0, 2);
      const deck = wt.concat(sizeItems);
      const answers = {};
      answers[POE.QID(deck[0])] = deck[0].opts[deck[0].ans];
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "all", shuffle: false, deck: deck.map(POE.QID), pos: 3, answers, finished: true, t: 7
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-legacy-banner]");
    const partialBanner = await page.$eval("[data-legacy-banner]", el => el.textContent);
    const mixed = await card(page, "mixed");
    ok(mixed.len === "5" && mixed.pos === "3" && mixed.status === "progress" && mixed.badge === "In progress", "a short multi-section save resumes as the mixed quiz at the same question");
    ok((await card(page, "wt")).status === "new" && (await card(page, "wt")).badge === "Not started", "a partial old quiz does not pass Weight");
    ok(partialBanner.includes("mixed quiz") && partialBanner.includes("did not mark any section passed"), "the note says the old mixed quiz was not turned into section passes");
    const mixedRow = await page.$eval('[data-mixed-section="wt"]', el => el.dataset.status);
    ok(mixedRow === "progress", "Weight inside that partial mixed quiz stays In progress");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS.filter(it => it.sec === "sec").slice(0, 5);
      const answers = {};
      items.forEach(it => { answers[POE.QID(it)] = it.opts[it.ans]; });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "sec", shuffle: false, deck: items.map(POE.QID), pos: 4, answers, finished: true, t: 8
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const secCard = await card(page, "sec");
    const secMixed = await card(page, "mixed");
    ok(secCard.status === "new" && secCard.badge === "Not started", "a 5-question Securement save is not graded as the full section");
    ok(secMixed.len === "5" && secMixed.answered === "5" && secMixed.badge === "Finished", "that short save is kept on the mixed quiz and is labeled Finished, not PASS (" + JSON.stringify(secMixed) + ")");
    const secRow = await page.$eval('[data-mixed-section="sec"]', el => ({ status: el.dataset.status, text: el.textContent }));
    ok(secRow.status === "progress" && secRow.text.includes("In progress"), "five correct Securement answers do not pass the section");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS;
      const answers = {};
      const misses = { wt: 0, size: 0, haz: 0 };
      items.forEach(it => {
        const limit = it.sec === "haz" ? 5 : it.sec === "wt" ? 2 : 0;
        const wrong = (misses[it.sec] || 0) < limit;
        if (wrong) misses[it.sec] = (misses[it.sec] || 0) + 1;
        const pick = wrong ? it.opts.find((_, k) => k !== it.ans) : it.opts[it.ans];
        answers[POE.QID(it)] = pick;
      });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "all", shuffle: false, deck: items.map(POE.QID), pos: 100, answers, finished: true, t: 9
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const fullMixed = await card(page, "mixed");
    const hazRow = await page.$eval('[data-mixed-section="haz"]', el => ({ status: el.dataset.status, text: el.textContent }));
    const wtRow = await page.$eval('[data-mixed-section="wt"]', el => ({ status: el.dataset.status, text: el.textContent }));
    const sizeRow = await page.$eval('[data-mixed-section="size"]', el => el.dataset.status);
    ok(fullMixed.len === "381" && fullMixed.pos === "100" && fullMixed.badge === "NEEDS WORK", "a finished 381-question save keeps its place and is not given one overall PASS");
    ok(hazRow.status === "needs" && hazRow.text.includes("NEEDS WORK"), "HazMat at 36/41 in the old mixed quiz is below 90%");
    ok(wtRow.status === "pass" && wtRow.text.includes("PASS"), "Weight with 2 misses in the old mixed quiz passes that section");
    ok(sizeRow === "pass", "a perfect Size section inside the finished mixed quiz passes");
    const hazOwn = await card(page, "haz");
    const wtOwn = await card(page, "wt");
    ok(hazOwn.status === "new" && hazOwn.badge === "Not started" && hazOwn.prior === "needs" && hazOwn.cls.includes("needs"), "HazMat's own quiz stays Not started while the mixed result is highlighted");
    ok(wtOwn.status === "new" && wtOwn.badge === "Not started", "Weight's own quiz is not marked PASS from the mixed save");
    const q100 = await page.evaluate(() => POE.ITEMS[100].q);
    await page.click('[data-action="resume"][data-section="mixed"]');
    await page.waitForSelector("h3");
    const mixedAt = await page.evaluate(() => ({
      pos: document.querySelector("[data-pos]").dataset.pos,
      q: document.querySelector("h3").textContent
    }));
    ok(mixedAt.pos === "100" && mixedAt.q === q100, "the old mixed quiz resumes question 101");

    await page.evaluate(() => localStorage.clear());
    await page.evaluate(() => {
      const items = POE.ITEMS.filter(it => it.sec === "reg");
      const answers = {};
      items.slice(0, 2).forEach(it => { answers[POE.QID(it)] = it.opts[it.ans]; });
      localStorage.setItem(POE.KEY_V1, JSON.stringify({
        filter: "reg", shuffle: false, deck: items.map(POE.QID), pos: 8, answers, finished: true, t: 10
      }));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-legacy-banner]");
    const gapBanner = await page.$eval("[data-legacy-banner]", el => el.textContent);
    const regGap = await card(page, "reg");
    ok(regGap.status === "progress" && regGap.badge === "In progress" && regGap.pos === "8" && regGap.answered === "2" && regGap.missed === "0", "a save marked finished with questions left stays In progress");
    ok(gapBanner.includes("not passed") || gapBanner.includes("In progress"), "the note says that unfinished save was not passed");

    await page.evaluate(() => localStorage.clear());
    const bogus = { filter: "all", shuffle: true, deck: ["missing-question"], pos: 3, answers: { "missing-question": "nope" }, finished: true, t: 11 };
    await page.evaluate(raw => localStorage.setItem(POE.KEY_V1, JSON.stringify(raw)), bogus);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("[data-legacy-banner]");
    const badges = await page.$$eval("#dash .badge", els => els.map(el => el.textContent.trim()));
    const kept = await page.evaluate(() => ({
      v1: localStorage.getItem(POE.KEY_V1),
      arch: JSON.parse(localStorage.getItem(POE.KEY_V1_ARCH)),
      detail: POE.state().legacy.detail
    }));
    ok(badges.every(b => b === "Not started"), "an unreadable old save does not pass any section");
    ok(kept.v1 === null && kept.arch.deck[0] === "missing-question" && kept.detail.includes("kept"), "an unreadable old save is still stored");
    await page.click('[data-action="dismiss-legacy"]');
    ok(!(await page.$("[data-legacy-banner]")), "the note can be hidden");
    const stillKept = await page.evaluate(() => JSON.parse(localStorage.getItem(POE.KEY_V1_ARCH)).deck[0] === "missing-question" && POE.state().legacy.raw.deck[0] === "missing-question");
    ok(stillKept, "hiding the note does not delete the save");

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    await page.click('[data-action="start"][data-section="eqp"]');
    await page.waitForSelector("h3");
    const q0 = await page.$eval("h3", el => el.dataset.qid);
    await page.click('[data-action="pick"][data-pick="0"]');
    await page.waitForSelector(".cite");
    ok((await page.$eval(".cite", el => el.textContent)).length > 3, "answering shows the citation");
    await page.click('[data-action="next"]');
    const q1 = await page.$eval("h3", el => el.dataset.qid);
    await page.click('[data-action="pick"][data-pick="0"]');
    await page.waitForSelector(".cite");
    await page.click('[data-action="next"]');
    const livePos = await page.$eval("[data-pos]", el => el.dataset.pos);
    const q2 = await page.$eval("h3", el => el.dataset.qid);
    ok(livePos === "2", "Next moves to the third question");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem(POE.KEY)).sections.eqp);
    ok(stored.pos === 2 && Object.keys(stored.answers).length === 2 && stored.deck[0] === q0 && stored.deck[2] === q2, "every answer and the exact place are written to storage");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[data-action="resume"][data-section="eqp"]');
    ok((await card(page, "eqp")).status === "progress" && (await card(page, "eqp")).pos === "2" && (await card(page, "eqp")).badge === "In progress", "reload shows Equipment in progress at question 3");
    await page.click('[data-action="resume"][data-section="eqp"]');
    ok(await page.$eval("h3", el => el.dataset.qid) === q2, "resume opens the same Equipment question");
    await page.click('[data-action="prev"]');
    const prevMarked = await page.evaluate(() => ({
      qid: document.querySelector("h3").dataset.qid,
      marked: !!document.querySelector(".opt.ok, .opt.bad"),
      cite: !!document.querySelector(".cite")
    }));
    ok(prevMarked.qid === q1 && prevMarked.marked && prevMarked.cite, "the previous answer is still marked after reload");
    await page.click('[data-action="home"]');
    await page.click('[data-action="start"][data-section="size"]');
    await page.waitForSelector("[data-pick]");
    await page.click('[data-action="pick"][data-pick="0"]');
    await page.waitForSelector(".cite");
    await page.click('[data-action="home"]');
    ok((await card(page, "eqp")).pos === "1" && (await card(page, "eqp")).answered === "2", "starting Size leaves Equipment on the question you last opened");
    ok((await card(page, "size")).status === "progress" && (await card(page, "size")).answered === "1" && (await card(page, "size")).pos === "0", "Size saves its own first answer");
    await page.click('[data-action="restart"][data-section="size"]');
    await page.click('[data-action="restart-no"]');
    ok((await card(page, "size")).answered === "1", "cancel leaves Size running");
    await page.click('[data-action="restart"][data-section="size"]');
    await page.click('[data-action="restart-yes"]');
    ok((await card(page, "size")).status === "new", "Size restart clears Size");
    ok((await card(page, "eqp")).status === "progress" && (await card(page, "eqp")).pos === "1" && (await card(page, "eqp")).answered === "2", "Size restart does not clear Equipment");
    ok(page.__errors.length === 0, "no script errors during the quiz: " + page.__errors.join(" | "));

    const keysBeforeUpdate = await page.evaluate(async () => await caches.keys());
    ok(keysBeforeUpdate.includes("poe-quiz-v30"), "normal load installs the v30 cache: " + keysBeforeUpdate.join(","));
  } finally {
    await browser.close();
  }

  const browser2 = await launch();
  try {
    server.setSw(STUB_V29);
    const page = await newPage(browser2);
    await page.goto(server.base, { waitUntil: "load" });
    await page.waitForSelector("#dash");
    const firstKeys = await waitKeys(page, keys => keys.includes("poe-quiz-v29"), 15000);
    ok(firstKeys.includes("poe-quiz-v29"), "first worker cache is the live v29: " + firstKeys.join(","));
    server.setSw(null);
    await page.reload({ waitUntil: "load" });
    const nextKeys = await waitKeys(page, keys => keys.length === 1 && keys[0] === "poe-quiz-v30", 15000);
    ok(nextKeys.length === 1 && nextKeys[0] === "poe-quiz-v30", "updating the worker drops v29 and keeps v30: " + nextKeys.join(","));
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const named = keys[0] ? await caches.open(keys[0]) : null;
      const hit = named ? await named.match("./index.html") : null;
      const text = hit ? await hit.text() : "";
      const marker = named ? await named.match("marker-v29") : null;
      return { hasApp: text.includes("Section quizzes") && text.includes("v30"), marker: !!marker, len: text.length };
    });
    ok(cached.hasApp && cached.marker === false, "v30 cache holds the section quiz and the v29 marker is gone (" + JSON.stringify(cached) + ")");
    const sub = await page.$eval("header .sub", el => el.textContent);
    ok(sub.includes("v30"), "updated page shows v30");
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#dash");
    const offline = await page.evaluate(() => ({
      heading: document.querySelector("#dash h2").textContent,
      n: POE.ITEMS.length,
      sub: document.querySelector("header .sub").textContent
    }));
    ok(offline.heading === "Section quizzes" && offline.n === 381 && offline.sub.includes("v30"), "offline reload serves the updated quiz and all 381 questions");
    await page.click('[data-action="start"][data-section="wt"]');
    await page.waitForSelector("h3");
    const offlineQ = await page.$eval("h3", el => el.textContent);
    ok(offlineQ.length > 40, "a section quiz starts from the offline cache");
    await page.click('[data-action="pick"][data-pick="0"]');
    await page.waitForSelector(".cite");
    const offlineSaved = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem(POE.KEY)).sections.wt;
      return Object.keys(saved.answers).length === 1 && saved.pos === 0;
    });
    ok(offlineSaved, "an offline answer is saved on the device");
    ok(page.__errors.filter(e => !/Failed to fetch|net::ERR_INTERNET_DISCONNECTED|NetworkError/.test(e)).length === 0, "offline page has no unexpected script errors: " + page.__errors.join(" | "));
    await shot(page, "offline_section_quiz.png");
  } finally {
    await browser2.close();
    server.srv.close();
  }

  if (failures.length) {
    console.error("\n" + failures.length + " failed");
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

async function waitKeys(page, pred, timeout) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeout) {
    try {
      last = await page.evaluate(async () => await caches.keys());
      if (pred(last)) return last;
    } catch (e) { /* navigation while the worker takes control */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return last;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
