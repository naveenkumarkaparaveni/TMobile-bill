/* ---------- Add these helper functions near the top of script.js ---------- */

const accountMap = {
    "(603) 943-6287" : "Anvesh - (603) 943-6287",
    "(770) 524-9973" : "Anvesh - (770) 524-9973",
    "(603) 943-6283" : "Abhilash - (603) 943-6283",
    "(603) 995-0299" : "Abhilash - (603) 995-0299",
    "(603) 943-4167" : "Mani Shankar - (603) 943-4167",
    "(650) 880-5586" : "Mani Shankar - (650) 880-5586",
    "(603) 943-6286" : "Naresh - (603) 943-6286",
    "(978) 421-5896" : "Uday - (978) 421-5896",
    "(978) 788-3102" : "Naveen - (978) 788-3102",
    "(603) 943-6285" : "Naveen - (603) 943-6285"
}

/**
 * Preprocess an image file: draw to canvas at a larger scale, grayscale, contrast,
 * simple threshold. Returns a dataURL suitable for Tesseract.recognize.
 */
function preprocessImage(file, options = {}) {
    const defaultOpts = { scaleFactor: 2, targetWidth: 1600, threshold: 150, sharpen: true };
    const opts = { ...defaultOpts, ...options };

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            // compute scaled size
            let w = img.width;
            let h = img.height;
            const targetW = Math.min(opts.targetWidth, w * opts.scaleFactor);
            const scale = targetW / w;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            const ctx = canvas.getContext('2d');

            // draw image scaled
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Get image data
            let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let data = imageData.data;

            // Convert to grayscale & increase contrast
            for (let i = 0; i < data.length; i += 4) {
                // luminosity
                const r = data[i], g = data[i + 1], b = data[i + 2];
                let lum = 0.299 * r + 0.587 * g + 0.114 * b;
                // simple contrast stretch: bring values away from mid
                lum = ((lum - 128) * 1.2) + 128; // 1.2 contrast multiplier
                if (lum < 0) lum = 0;
                if (lum > 255) lum = 255;
                data[i] = data[i + 1] = data[i + 2] = lum;
            }

            // optional simple sharpening kernel (not heavy)
            if (opts.sharpen) {
                // apply a very light unsharp-like filter using convolution (3x3)
                const w = canvas.width, h = canvas.height;
                const copy = new Uint8ClampedArray(data); // copy
                const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0]; // sharpen-ish
                for (let y = 1; y < h - 1; y++) {
                    for (let x = 1; x < w - 1; x++) {
                        let r = 0, g = 0, b = 0;
                        let kIdx = 0;
                        for (let ky = -1; ky <= 1; ky++) {
                            for (let kx = -1; kx <= 1; kx++) {
                                const px = x + kx;
                                const py = y + ky;
                                const pIdx = (py * w + px) * 4;
                                r += copy[pIdx + 0] * kernel[kIdx];
                                g += copy[pIdx + 1] * kernel[kIdx];
                                b += copy[pIdx + 2] * kernel[kIdx];
                                kIdx++;
                            }
                        }
                        const idx = (y * w + x) * 4;
                        data[idx + 0] = Math.min(255, Math.max(0, r));
                        data[idx + 1] = Math.min(255, Math.max(0, g));
                        data[idx + 2] = Math.min(255, Math.max(0, b));
                    }
                }
            }

            // simple global thresholding to remove background noise
            for (let i = 0; i < data.length; i += 4) {
                const v = data[i]; // grayscale value
                const out = v > opts.threshold ? 255 : 0;
                data[i] = data[i + 1] = data[i + 2] = out;
            }

            // put back
            ctx.putImageData(imageData, 0, 0);

            // return a data URL (PNG)
            const dataURL = canvas.toDataURL('image/png');
            resolve(dataURL);
        };

        img.onerror = (e) => reject(new Error('Failed to load image for preprocessing: ' + e));
        // read file as dataURL
        const reader = new FileReader();
        reader.onload = () => { img.src = reader.result; };
        reader.onerror = (e) => reject(new Error('FileReader error: ' + e));
        reader.readAsDataURL(file);
    });
}

/* ----- Utilities ----- */

function formatMoney(n) {
    return "$" + n.toFixed(2);
}

function parseMoneyToken(token) {
    if (!token) return 0;
    token = token.trim();
    if (token === "-" || /^-+$/.test(token)) return 0;

    const paren = /^\(?\s*([-\d$,]+(?:\.\d{1,2})?)\s*\)?$/.exec(token);
    if (paren) {
        const inner = paren[1].replace(/[$,]/g, "");
        let val = parseFloat(inner || 0);
        if (token.startsWith("(") && token.endsWith(")")) val = -Math.abs(val);
        return isNaN(val) ? 0 : val;
    }

    const cleaned = token.replace(/[$,()]/g, "");
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
}

/* ----- Parsing logic ----- */

/**
 * parseBillText
 * - text: OCR or raw text
 * - returns: array of rows { account, plans, equipment, services, total }
 *
 * Behavior:
 * - finds "Totals" line and uses its first money value as the Plans pool
 * - collects account lines (those containing phone numbers)
 * - extracts up to 3 money tokens per account, aligns them to the right:
 *     [plans, equipment, services]  <-- right-aligned so single token => services
 * - splits the Totals plan pool equally among accounts (cent-accurate)
 */
function parseBillText(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // regexes
    const phoneRegex = /(?:\+?1[\s-]*)?(?:\(?\d{3}\)?)[\s.\-]?\d{3}[\s.\-]?\d{4}/;
    const moneyTokenRegex = /(?:\(?\$?[\d,]+(?:\.\d{1,2})?\)?|-+)/g;

    // find Totals line and grab first money value (plans pool)
    let totalPlans = null;
    for (const line of lines) {
        if (/^\s*Totals?\b/i.test(line) || /\bTotals?\b/i.test(line)) {
            const toks = (line.match(moneyTokenRegex) || []).map(t => parseMoneyToken(t));
            if (toks.length > 0) {
                totalPlans = toks[0]; // first money value on Totals line is the plans pool
                break;
            }
        }
    }

    // collect account rows
    const accountRows = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!phoneRegex.test(line)) continue;

        // remove phone from line copy so tokens reflect columns only
        const account = (line.match(phoneRegex) || [""])[0].trim();
        const lineNoPhone = line.replace(phoneRegex, '').replace(/\s{2,}/g, ' ').trim();

        // extract money tokens from the phone-stripped line
        const tokens = (lineNoPhone.match(moneyTokenRegex) || []).map(t => t.trim());

        // convert tokens to numeric, treating '-' as zero
        const cleaned = tokens.map(t => parseMoneyToken(t));

        // align to the right into [plans, equipment, services]
        const cols = [0, 0, 0]; // plans, equipment, services
        const start = Math.max(0, 3 - cleaned.length);
        for (let j = 0; j < cleaned.length && (start + j) < 3; j++) {
            cols[start + j] = cleaned[j];
        }

        accountRows.push({
            account,
            // temporarily set plans from parsed (will be overwritten if Totals exists)
            plans: cols[0],
            equipment: cols[1],
            services: cols[2]
        });
    }

    // If no accounts found, return empty
    if (accountRows.length === 0) return [];

    // If a Totals plan pool was found, split it equally among accounts
    if (totalPlans !== null && !isNaN(totalPlans)) {
        const num = accountRows.length;
        const totalCents = Math.round(totalPlans * 100);
        const baseShare = Math.floor(totalCents / num);
        const remainder = totalCents - baseShare * num; // leftover cents

        for (let i = 0; i < accountRows.length; i++) {
            const shareCents = baseShare + (i < remainder ? 1 : 0);
            accountRows[i].plans = shareCents / 100;
        }
    } else {
        // If no Totals pool, we leave plan values as parsed (or zeros)
        // Optionally, you might want to compute plans per-account from original parsed values
    }

    // compute totals per account and return
    const result = accountRows.map(r => {
        const total = +( (r.plans || 0) + (r.equipment || 0) + (r.services || 0) ).toFixed(2);
        return {
            account: accountMap[r.account],
            plans: +( (r.plans || 0).toFixed(2) ),
            equipment: +( (r.equipment || 0).toFixed(2) ),
            services: +( (r.services || 0).toFixed(2) ),
            total
        };
    });

    // deduplicate exact duplicates (optional, kept from your previous logic)
    const unique = [];
    const seen = new Set();
    for (const r of result) {
        const key = [r.account, r.plans, r.equipment, r.services, r.total].join("|");
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(r);
        }
    }

    return unique.sort((a, b) => a.account.localeCompare(b.account));
}

/* ----- Splitting logic ----- */

function splitPlansEqually(data) {
    if (!data || data.length === 0) return [];

    const num = data.length;
    const totalPlans = data.reduce((s, r) => s + r.plans, 0);

    const totalCents = Math.round(totalPlans * 100);
    const baseShareCents = Math.floor(totalCents / num);
    const remainder = totalCents - baseShareCents * num;

    return data.map((r, i) => {
        const shareCents = baseShareCents + (i < remainder ? 1 : 0);
        const share = shareCents / 100;



        return {
            account: r.account,
            plans: share,
            equipment: r.equipment,
            services: r.services,
            total: +(share + r.equipment + r.services).toFixed(2)
        };
    });
}

/* ----- UI Rendering ----- */

function renderTable(data) {
    const table = document.getElementById("outputTable");
    table.innerHTML = "";

    if (!data || data.length === 0) {
        table.insertAdjacentHTML("beforeend", `<tr><td class="account">No rows found.</td></tr>`);
        return;
    }

    const header = `
    <tr>
      <th class="account">Account</th>
      <th>Plans (Equal Share)</th>
      <th>Equipment</th>
      <th>Services</th>
      <th>Total</th>
    </tr>
  `;
    table.insertAdjacentHTML("beforeend", header);

    let csv = ["Account,Plans,Equipment,Services,Total"];

    data.forEach(row => {
        table.insertAdjacentHTML("beforeend", `
      <tr>
        <td class="account">${row.account}</td>
        <td>${formatMoney(row.plans)}</td>
        <td>${formatMoney(row.equipment)}</td>
        <td>${formatMoney(row.services)}</td>
        <td>${formatMoney(row.total)}</td>
      </tr>
    `);

        csv.push(
            `"${row.account}",${row.plans.toFixed(2)},${row.equipment.toFixed(2)},${row.services.toFixed(2)},${row.total.toFixed(2)}`
        );
    });

    const csvData = csv.join("\n");
    const blob = new Blob([csvData], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const dl = document.getElementById("downloadBtn");
    dl.setAttribute("href", url); // set blob URL
    dl.download = "bill_split.csv";
    dl.removeAttribute("disabled");


}

/* ----- OCR Handling ----- */

// Option A: Compatibility fallback using Tesseract.recognize
/* ---------- Replace your processImageFile with this version ---------- */

async function processImageFile(file) {
    const status = document.getElementById("status");
    status.textContent = "⏳ Preparing image for OCR...";

    const doPreprocess = document.getElementById("preprocessCheck")?.checked ?? true;
    let ocrInput; // either dataURL or file

    try {
        if (doPreprocess) {
            status.textContent = "⏳ Preprocessing image (resize, grayscale, threshold)...";
            ocrInput = await preprocessImage(file, { scaleFactor: 2, targetWidth: 1600, threshold: 150, sharpen: true });
        } else {
            // use original file if not preprocessing
            ocrInput = file;
        }
    } catch (err) {
        console.warn("Preprocess failed, falling back to original file:", err);
        ocrInput = file;
    }

    // Use recognize (compatible with CDN) and display raw OCR
    status.textContent = "⏳ Running OCR (this may take a few seconds)...";

    try {
        const { data: { text } } = await Tesseract.recognize(ocrInput, 'eng', {
            logger: m => {
                let pct = m.progress ? Math.round(m.progress * 100) : "";
                status.textContent = `${m.status}${pct !== "" ? " " + pct + "%" : ""}`;
            }
        });

        // put raw OCR into textarea so user can correct it
        // const rawEl = document.getElementById('rawOcrText');
        return text;


    } catch (err) {
        console.error(err);
        status.textContent = "❌ OCR error: " + (err && err.message ? err.message : err);
        renderTable([]);
    }
}

/* ----- DOM Wiring ----- */

document.getElementById("imgInput").addEventListener("change", ev => {
    const file = ev.target.files[0];
    const preview = document.getElementById("preview");

    if (file) {
        preview.src = URL.createObjectURL(file);
        const downloadBtn = document.getElementById("downloadBtn");
        downloadBtn.removeAttribute("href");
        downloadBtn.disabled = true;

        document.getElementById("status").textContent = "Image loaded — ready.";
    } else {
        preview.src = "";
    }
});

document.getElementById("processBtn").addEventListener("click", async () => {
    const file = document.getElementById("imgInput").files[0];
    if (!file) return alert("Please upload an image first.");

    document.getElementById("processBtn").disabled = true;
    // Di0sable
    const downloadBtn = document.getElementById("downloadBtn");
    downloadBtn.disabled = true;
    downloadBtn.removeAttribute("href");

    try {
        const raw = await processImageFile(file);

        if (!raw.trim()) {
            alert("No OCR text to parse. Run OCR first or paste text into the Raw OCR box.");
            return;
        }
        const parsed = parseBillText(raw);
        if (!parsed || parsed.length === 0) {
            document.getElementById("status").textContent = "⚠ No rows parsed from the provided text.";
            renderTable([]);
            return;
        }
        const finalRows = splitPlansEqually(parsed);
        renderTable(finalRows);
        document.getElementById("status").textContent = `✔ Parsed ${finalRows.length} rows.`;

    } finally {
        document.getElementById("processBtn").disabled = false;
    }
});


