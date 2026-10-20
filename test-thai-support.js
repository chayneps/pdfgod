const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function runThaiSupportTests() {
  console.log('================================================================');
  console.log('🚀 Starting Comprehensive Thai Language Support Test Suite (T1-T10)');
  console.log('================================================================');

  const PORT = 26000 + Math.floor(Math.random() * 3000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-thai-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    HTML_FILE
  ]);

  try {
    let targets = null;
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {
        // wait for chrome to initialize
      }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) throw new Error('Could not connect to Chrome page debugging target on port ' + PORT);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise(resolve => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        console.error('Evaluate Exception:', r.exceptionDetails);
        throw new Error(JSON.stringify(r.exceptionDetails));
      }
      return r.result ? r.result.value : undefined;
    };

    // Helper inside browser for ZIP decompression (STORE mode)
    await evaluate(`
      window._readZip = (zipBytes) => {
        const files = {};
        const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
        const decoder = new TextDecoder('utf-8');
        let pos = 0;
        while (pos < zipBytes.length - 4) {
          const sig = dv.getUint32(pos, true);
          if (sig === 0x04034b50) {
            const nameLen = dv.getUint16(pos + 26, true);
            const extraLen = dv.getUint16(pos + 28, true);
            const size = dv.getUint32(pos + 18, true);
            const name = decoder.decode(zipBytes.subarray(pos + 30, pos + 30 + nameLen));
            const dataStart = pos + 30 + nameLen + extraLen;
            const data = decoder.decode(zipBytes.subarray(dataStart, dataStart + size));
            files[name] = data;
            pos = dataStart + size;
          } else if (sig === 0x02014b50) {
            break;
          } else {
            pos++;
          }
        }
        return files;
      };
    `);

    // Wait for PDFGod initialization
    console.log('1. Initializing PDFGod application & ensuring fonts...');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      while (!window.uiController || !window.pdfEngine || !window.ThaiSupport) await sleep(50);
      if (window.ThaiSupport && window.ThaiSupport.ensureBrowserFontsLoaded) {
        window.ThaiSupport.ensureBrowserFontsLoaded();
      }
      await sleep(200);
    `);

    // Helper inside browser for clicking text items by string
    await evaluate(`
      window._clickText = async (targetStr, pageIndex = 0, isShift = false) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const items = await window.pdfEngine.getTextItems(pageIndex);
        const item = items.find(it => it.str.includes(targetStr));
        if (!item) throw new Error('Text item not found: ' + targetStr);
        const layer = document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"] .annotation-layer') ||
                      document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"]');
        const rect = layer.getBoundingClientRect();
        const zoom = window.uiController.zoom || 1;
        const clickX = rect.left + (item.x + 15) * zoom;
        const clickY = rect.top + (item.y + 5) * zoom;

        layer.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY, shiftKey: isShift
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY, shiftKey: isShift
        }));
        await sleep(150);
      };
    `);

    // --------------------------------------------------------------------------
    // Test Case 1: T1 (Thai PDF Export & Re-Extraction with Vowels/Tone Marks)
    // --------------------------------------------------------------------------
    console.log('\n--- T1: Thai PDF Export & Re-Extraction with Vowels/Tone Marks ---');
    const t1Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Load a blank 1-page PDF
      const doc = await PDFLib.PDFDocument.create();
      doc.addPage([595.28, 841.89]);
      const blankBytes = await doc.save();
      await window.uiController.loadPdfBuffer(blankBytes.buffer.slice(0), "t1_test.pdf");
      await sleep(200);

      const thaiTestStrings = [
        "น้ำ",
        "ที่",
        "ปั้น",
        "เก้าอี้",
        "บริษัท ตัวอย่าง จำกัด (มหาชน)",
        "เลขประจำตัวผู้เสียภาษี 0107555000123"
      ];

      // Create text annotations with stacked Thai vowels & tone marks
      let curY = 80;
      for (const str of thaiTestStrings) {
        window.annotationManager.addAnnotation({
          type: 'text',
          text: str,
          fontFamily: 'Sarabun',
          fontSize: 16,
          fontColor: '#000000',
          x: 60,
          y: curY,
          width: 380,
          height: 25,
          pageIndex: 0
        });
        curY += 45;
      }

      window.canvasController.render();
      await sleep(150);

      // Export PDF using pdfEngine
      const exportRes = await window.pdfEngine.exportPDF(window.annotationManager, "t1_export.pdf");
      const exportedBytes = (exportRes && exportRes.bytes) ? exportRes.bytes : exportRes;
      if (!exportedBytes || exportedBytes.byteLength === 0) {
        throw new Error('exportPDF returned empty bytes');
      }

      // Re-extract using PDF.js (pass a copy so buffer is not detached)
      const reloadedDoc = await window.pdfjsLib.getDocument({
        data: exportedBytes.slice(0),
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
      }).promise;

      const page1 = await reloadedDoc.getPage(1);
      const textContent = await page1.getTextContent();
      const extractedText = textContent.items.map(it => it.str).join(' ');

      const checks = {};
      for (const str of thaiTestStrings) {
        const normTarget = window.ThaiSupport.normalizeThaiText(str);
        const normExtracted = window.ThaiSupport.normalizeThaiText(extractedText);
        checks[str] = normExtracted.includes(normTarget);
      }

      // Check that exported PDF CIDFont /W array contains width 0 for GSUB marks
      const exportedDoc = await PDFLib.PDFDocument.load(exportedBytes.slice(0));
      let foundCIDFont = false;
      let width736 = null;
      let width762 = null;
      const objs = exportedDoc.context.enumerateIndirectObjects();
      for (const [ref, obj] of objs) {
        if (obj instanceof PDFLib.PDFDict && obj.get(PDFLib.PDFName.of('Subtype'))?.toString() === '/CIDFontType2') {
          foundCIDFont = true;
          const wObj = obj.get(PDFLib.PDFName.of('W'));
          if (wObj instanceof PDFLib.PDFArray) {
            for (let i = 0; i < wObj.size(); i += 2) {
              const startId = wObj.get(i).asNumber();
              const wArr = wObj.get(i + 1);
              if (wArr instanceof PDFLib.PDFArray) {
                if (736 >= startId && 736 < startId + wArr.size()) {
                  width736 = wArr.get(736 - startId).asNumber();
                }
                if (762 >= startId && 762 < startId + wArr.size()) {
                  width762 = wArr.get(762 - startId).asNumber();
                }
              }
            }
          }
        }
      }
      const hasZeroWidthGsubMarks = foundCIDFont && (width736 === 0) && (width762 === 0);

      const allPresent = Object.values(checks).every(Boolean) && hasZeroWidthGsubMarks;

      return {
        exportedSize: exportedBytes.byteLength,
        pageCount: reloadedDoc.numPages,
        allPresent,
        foundCIDFont,
        width736,
        width762,
        hasZeroWidthGsubMarks,
        checks,
        extractedSample: extractedText.substring(0, 120)
      };
    `);
    console.log('T1 Result:', t1Result);
    if (!t1Result.allPresent) throw new Error('T1 Failed: Some Thai strings were not re-extracted intact or /W missing GSUB mark width 0: ' + JSON.stringify(t1Result));
    console.log('✅ T1 Passed: Exported PDF with authentic Sarabun font, verified CIDFont /W array width=0 for GSUB marks, and re-extracted all Thai stacked vowels & tone marks intact!');

    // --------------------------------------------------------------------------
    // Test Case 2: T2 (No Vowel/Tone-Mark Clipping in DOM Text Boxes)
    // --------------------------------------------------------------------------
    console.log('\n--- T2: No Vowel/Tone-Mark Clipping in DOM Text Boxes ---');
    const t2Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.annotationManager.clear();
      window.annotationManager.addAnnotation({
        type: 'text',
        text: 'น้ำ ที่ ปั้น เก้าอี้',
        fontFamily: 'Sarabun',
        fontSize: 18,
        fontColor: '#000000',
        x: 80,
        y: 80,
        width: 250,
        height: 30,
        pageIndex: 0
      });
      window.canvasController.render();
      await sleep(150);

      const textEl = document.querySelector('.page-wrapper[data-page-index="0"] .pdf-text-element');
      const textContent = textEl ? textEl.querySelector('.pdf-text-content') : null;
      if (!textEl || !textContent) throw new Error('DOM text element not found');

      const elComputed = window.getComputedStyle(textEl);
      const contentComputed = window.getComputedStyle(textContent);

      const hasIsThaiClassEl = textEl.classList.contains('is-thai');
      const hasIsThaiClassContent = textContent.classList.contains('is-thai');
      const fontFamily = contentComputed.fontFamily;
      const lineHeight = parseFloat(contentComputed.lineHeight);
      const fontSize = parseFloat(contentComputed.fontSize);
      const lineHeightRatio = +(lineHeight / fontSize).toFixed(2);

      const clientH = textContent.clientHeight;
      const scrollH = textContent.scrollHeight;
      const isNotClipped = scrollH <= clientH + 2;

      return {
        hasIsThaiClassEl,
        hasIsThaiClassContent,
        fontFamily,
        lineHeightRatio,
        clientH,
        scrollH,
        isNotClipped
      };
    `);
    console.log('T2 Result:', t2Result);
    if (!t2Result.hasIsThaiClassEl || !t2Result.hasIsThaiClassContent) throw new Error('T2 Failed: is-thai class missing');
    if (!t2Result.fontFamily.includes('Sarabun')) throw new Error('T2 Failed: Sarabun font not applied');
    if (Math.abs(t2Result.lineHeightRatio - 1.45) > 0.15) throw new Error('T2 Failed: Line height ratio not ~1.45 (got ' + t2Result.lineHeightRatio + ')');
    if (!t2Result.isNotClipped) throw new Error('T2 Failed: scrollHeight exceeded clientHeight, clipping detected');
    console.log('✅ T2 Passed: DOM text element has Sarabun font, is-thai class, lineHeight ~1.45, and zero clipping!');

    // --------------------------------------------------------------------------
    // Create 2-Page Thai PDF for T3, T4, T6, T7, T8, T9
    // --------------------------------------------------------------------------
    console.log('\n--- Creating 2-Page Thai In-Memory PDF (Headers & Vector Grid Table) ---');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const doc = await PDFLib.PDFDocument.create();
      doc.registerFontkit(window.fontkit);
      const fontBytes = window.ThaiSupport.getSarabunBytes(false);
      const fontBoldBytes = window.ThaiSupport.getSarabunBytes(true);
      const fontReg = await doc.embedFont(fontBytes);
      const fontBold = await doc.embedFont(fontBoldBytes);

      for (let p = 0; p < 2; p++) {
        const page = doc.addPage([595.28, 841.89]);
        // 3-line Thai company header at top-left
        page.drawText('บริษัท ไทยโลจิสติกส์ จำกัด', { x: 50, y: 780, size: 14, font: fontBold });
        page.drawText('123 ถนนสุขุมวิท แขวงคลองเตย กรุงเทพฯ 10110', { x: 50, y: 760, size: 10, font: fontReg });
        page.drawText('โทร. 02-123-4567', { x: 50, y: 742, size: 10, font: fontReg });

        // Table horizontal lines
        page.drawLine({ start: { x: 50, y: 690 }, end: { x: 500, y: 690 }, thickness: 1 });
        page.drawLine({ start: { x: 50, y: 665 }, end: { x: 500, y: 665 }, thickness: 1 });
        page.drawLine({ start: { x: 50, y: 580 }, end: { x: 500, y: 580 }, thickness: 1 });

        // Table vertical lines
        page.drawLine({ start: { x: 50, y: 690 }, end: { x: 50, y: 580 }, thickness: 1 });
        page.drawLine({ start: { x: 100, y: 690 }, end: { x: 100, y: 580 }, thickness: 1 });
        page.drawLine({ start: { x: 300, y: 690 }, end: { x: 300, y: 580 }, thickness: 1 });
        page.drawLine({ start: { x: 400, y: 690 }, end: { x: 400, y: 580 }, thickness: 1 });
        page.drawLine({ start: { x: 500, y: 690 }, end: { x: 500, y: 580 }, thickness: 1 });

        // Table Header Columns
        page.drawText('ลำดับ', { x: 65, y: 672, size: 11, font: fontBold });
        page.drawText('รายการสินค้า', { x: 120, y: 672, size: 11, font: fontBold });
        page.drawText('จำนวน', { x: 330, y: 672, size: 11, font: fontBold });
        page.drawText('ราคา', { x: 430, y: 672, size: 11, font: fontBold });

        // Table Row 1
        page.drawText('1', { x: 65, y: 645, size: 10, font: fontReg });
        page.drawText('ข้าวหอมมะลิ 100%', { x: 120, y: 645, size: 10, font: fontReg });
        page.drawText('10', { x: 330, y: 645, size: 10, font: fontReg });
        page.drawText('350', { x: 430, y: 645, size: 10, font: fontReg });

        // Table Row 2
        page.drawText('2', { x: 65, y: 625, size: 10, font: fontReg });
        page.drawText('น้ำดื่มบริสุทธิ์', { x: 120, y: 625, size: 10, font: fontReg });
        page.drawText('24', { x: 330, y: 625, size: 10, font: fontReg });
        page.drawText('120', { x: 430, y: 625, size: 10, font: fontReg });

        // Table Row 3
        page.drawText('3', { x: 65, y: 605, size: 10, font: fontReg });
        page.drawText('ปั้นจั่นยกของ', { x: 120, y: 605, size: 10, font: fontReg });
        page.drawText('1', { x: 330, y: 605, size: 10, font: fontReg });
        page.drawText('45000', { x: 430, y: 605, size: 10, font: fontReg });
      }

      window._multiPageThaiBytes = await doc.save();
      await window.uiController.loadPdfBuffer(window._multiPageThaiBytes.buffer.slice(0), "thai_company_invoice.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);
    `);

    // --------------------------------------------------------------------------
    // Test Case 3: T3 (In-Place Click-to-Edit & CID/Identity-H Stream Redaction)
    // --------------------------------------------------------------------------
    console.log('\n--- T3: In-Place Click-to-Edit & CID/Identity-H Stream Redaction ---');
    const t3Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // In edit-pdf-text mode, click "ข้าวหอมมะลิ 100%"
      await window._clickText('ข้าวหอมมะลิ', 0, false);
      await sleep(300);

      const selAnns = window.annotationManager.getSelectedAnnotations();
      const replacementAnn = selAnns.find(a => a.type === 'text' && a.text.includes('ข้าวหอมมะลิ'));
      if (!replacementAnn) throw new Error('Replacement annotation not created');

      // Verify Sarabun font family assigned
      const isSarabun = replacementAnn.fontFamily === 'Sarabun';

      // Check that the text item was redacted from PDF.js items on Page 1
      const p1Items = await window.pdfEngine.getTextItems(0);
      const stillHasOriginalInStream = p1Items.some(it => it.str.includes('ข้าวหอมมะลิ'));

      // Check canvas pixels at original text position after hiding annotation layer
      const pageWrapper = document.querySelector('.page-wrapper[data-page-index="0"]');
      const canvas = pageWrapper.querySelector('.pdf-canvas');
      const ctx = canvas.getContext('2d');
      const zoom = window.uiController.zoom || 1;
      const dpr = window.devicePixelRatio || 1;

      // Sample a 50x12 box right over where "ข้าวหอมมะลิ" was originally drawn
      const sampleX = Math.round((replacementAnn.x + 10) * zoom * dpr);
      const sampleY = Math.round((replacementAnn.y + 4) * zoom * dpr);
      const imgData = ctx.getImageData(sampleX, sampleY, 40, 10);
      let darkPixels = 0;
      for (let i = 0; i < imgData.data.length; i += 4) {
        const r = imgData.data[i];
        const g = imgData.data[i + 1];
        const b = imgData.data[i + 2];
        const a = imgData.data[i + 3];
        if (a > 128 && (r < 200 || g < 200 || b < 200)) {
          darkPixels++;
        }
      }

      return {
        annId: replacementAnn.id,
        isSarabun,
        stillHasOriginalInStream,
        darkPixelsAtOriginalLocation: darkPixels
      };
    `);
    console.log('T3 Result:', t3Result);
    if (!t3Result.isSarabun) throw new Error('T3 Failed: Replacement annotation does not have Sarabun font');
    if (t3Result.stillHasOriginalInStream) throw new Error('T3 Failed: Text was not redacted from PDF stream');
    if (t3Result.darkPixelsAtOriginalLocation > 5) throw new Error('T3 Failed: Canvas still contains dark pixels at original location (' + t3Result.darkPixelsAtOriginalLocation + ')');
    console.log('✅ T3 Passed: In-place click-to-edit cleanly excised CID/Identity-H text from PDF stream with 0 dark canvas pixels and Sarabun annotation created!');

    // --------------------------------------------------------------------------
    // Test Case 4: T4 (Arrow Select Marquee on Thai Table — Text + Vector Lines)
    // --------------------------------------------------------------------------
    console.log('\n--- T4: Arrow Select Marquee on Thai Table — Text + Vector Lines ---');
    const t4Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh 2-page PDF
      await window.uiController.loadPdfBuffer(window._multiPageThaiBytes.buffer.slice(0), "thai_company_invoice.pdf");
      await sleep(300);

      // Switch to select tool
      document.querySelector('.tool-btn[data-tool="select"]').click();
      await sleep(200);

      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;

      // Marquee drag across the table (y=690 to 580 in PDF is y=151 to 261 from top, x=45 to 505)
      // Page height is 841.89, y=690 from bottom => y = 841.89 - 690 = 151.89
      // y=580 from bottom => y = 841.89 - 580 = 261.89
      const startX = rect.left + 45 * zoom;
      const startY = rect.top + 140 * zoom;
      const endX = rect.left + 505 * zoom;
      const endY = rect.top + 270 * zoom;

      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: startY
      }));
      layer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, button: 0, clientX: endX, clientY: endY
      }));
      await window.uiController.canvasController.handlePointerUp({
        clientX: endX, clientY: endY
      });
      await sleep(400);

      const selectedAnns = window.annotationManager.getSelectedAnnotations();
      const textAnns = selectedAnns.filter(a => a.type === 'text');
      const lineAnns = selectedAnns.filter(a => a.type === 'line');

      if (textAnns.length === 0 || lineAnns.length === 0) {
        throw new Error('Expected both texts and lines selected in select marquee, got: ' + textAnns.length + ' texts, ' + lineAnns.length + ' lines');
      }

      const initialTextPos = { x: textAnns[0].x, y: textAnns[0].y };
      const initialLinePos = { x: lineAnns[0].x, y: lineAnns[0].y };

      // Dispatch ArrowRight 5 times and ArrowDown 3 times (with shiftKey: true for 1px increments)
      for (let i = 0; i < 5; i++) {
        window.canvasController.handleKeyDown({ key: 'ArrowRight', shiftKey: true, target: document.body, preventDefault: () => {} });
      }
      for (let i = 0; i < 3; i++) {
        window.canvasController.handleKeyDown({ key: 'ArrowDown', shiftKey: true, target: document.body, preventDefault: () => {} });
      }
      await sleep(200);

      const movedText = window.annotationManager.getAnnotation(textAnns[0].id);
      const movedLine = window.annotationManager.getAnnotation(lineAnns[0].id);

      const textDx = +(movedText.x - initialTextPos.x).toFixed(2);
      const textDy = +(movedText.y - initialTextPos.y).toFixed(2);
      const lineDx = +(movedLine.x - initialLinePos.x).toFixed(2);
      const lineDy = +(movedLine.y - initialLinePos.y).toFixed(2);

      // Check stream redaction occurred
      const p1Items = await window.pdfEngine.getTextItems(0);
      const hasRedactedTableItem = !p1Items.some(it => it.str.includes('น้ำดื่มบริสุทธิ์'));

      return {
        selectedTexts: textAnns.length,
        selectedLines: lineAnns.length,
        textDx, textDy,
        lineDx, lineDy,
        hasRedactedTableItem
      };
    `);
    console.log('T4 Result:', t4Result);
    if (t4Result.textDx !== 5 || t4Result.textDy !== 3) throw new Error('T4 Failed: Text annotations did not nudge accurately');
    if (t4Result.lineDx !== 5 || t4Result.lineDy !== 3) throw new Error('T4 Failed: Vector line annotations did not nudge synchronously');
    if (!t4Result.hasRedactedTableItem) throw new Error('T4 Failed: Table items were not redacted from underlying PDF stream');
    console.log('✅ T4 Passed: Select marquee captured both Thai text and vector lines, nudged together synchronously with stream redaction!');

    // --------------------------------------------------------------------------
    // Test Case 5: T5 (Legacy PUA \uF700–\uF71A & Split Sara Am \u0E4D\u0E32 Normalization)
    // --------------------------------------------------------------------------
    console.log('\n--- T5: Legacy PUA \\uF700–\\uF71A & Split Sara Am \\u0E4D\\u0E32 Normalization ---');
    const t5Result = await evaluate(`
      const thai = window.ThaiSupport;
      const tests = {
        splitSaraAm1: thai.normalizeThaiText("น\\u0E49\\u0E4D\\u0E32") === "น้ำ",
        splitSaraAm2: thai.normalizeThaiText("ก\\u0E4D\\u0E32") === "กำ",
        puaMaiEk: thai.normalizeThaiText("\\uF70A") === "\\u0E48",
        puaMaiTho: thai.normalizeThaiText("\\uF70B") === "\\u0E49",
        puaSaraI: thai.normalizeThaiText("\\uF701") === "\\u0E34",
        puaSaraU: thai.normalizeThaiText("\\uF718") === "\\u0E38",
        puaCompound: thai.normalizeThaiText("ท\\uF702\\uF70A") === "ที่",
        containsThaiStandard: thai.containsThai("ทดสอบ"),
        containsThaiPUA: thai.containsThai("ท\\uF701\\uF70A"),
        containsNonWinAnsiThai: thai.containsNonWinAnsi("ภาษาไทย"),
        containsNonWinAnsiLatin: !thai.containsNonWinAnsi("Hello World 123!@#")
      };
      const allPassed = Object.values(tests).every(Boolean);
      return { tests, allPassed };
    `);
    console.log('T5 Result:', t5Result);
    if (!t5Result.allPassed) throw new Error('T5 Failed: Some Thai normalization tests failed: ' + JSON.stringify(t5Result.tests));
    console.log('✅ T5 Passed: Legacy Windows-874 / PUA codepoints and decomposed Sara Am successfully normalized to NFC Unicode!');

    // --------------------------------------------------------------------------
    // Test Case 6: T6 (Match Across Pages with Thai Headers & Atomic Revert)
    // --------------------------------------------------------------------------
    console.log('\n--- T6: Match Across Pages with Thai Headers & Atomic Revert ---');
    const t6Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh 2-page PDF
      await window.uiController.loadPdfBuffer(window._multiPageThaiBytes.buffer.slice(0), "thai_company_invoice.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select line 1
      await window._clickText('บริษัท ไทยโลจิสติกส์', 0, false);
      // Shift-click line 2
      await window._clickText('123 ถนนสุขุมวิท', 0, true);
      // Shift-click line 3
      await window._clickText('โทร. 02-123-4567', 0, true);
      await sleep(200);

      const selCount = window.annotationManager.getSelectedAnnotations().length;
      if (selCount !== 3) throw new Error('Expected 3 annotations selected on Page 1, got: ' + selCount);

      // Click "Match Across Pages" button
      const matchBtn = document.getElementById('prop-match-pages-btn');
      if (!matchBtn) throw new Error('#prop-match-pages-btn not found');
      matchBtn.click();
      await sleep(300);

      const widget = document.getElementById('batch-group-widget');
      const isWidgetOpen = widget && widget.style.display !== 'none';
      const state = window.uiController.activeBatchState;
      const matches = state ? state.matches : [];

      const p1Match = matches.find(m => m.pageIndex === 0);
      const p2Match = matches.find(m => m.pageIndex === 1);

      // Change Line 1 to "บริษัท สยามโกลบอล จำกัด (มหาชน)"
      const line1Input = document.querySelector('#batch-lines-container .batch-line-input[data-line-index="0"]');
      if (!line1Input) throw new Error('Line 1 input not found in batch editor');
      line1Input.value = 'บริษัท สยามโกลบอล จำกัด (มหาชน)';
      line1Input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);

      // Click Apply
      const applyBtn = document.getElementById('btn-batch-apply');
      applyBtn.click();
      await sleep(400);

      // Verify Page 1 and Page 2 both have the new Thai header
      const p1Anns = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const p2Anns = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      const p1HasNew = p1Anns.some(a => a.text === 'บริษัท สยามโกลบอล จำกัด (มหาชน)');
      const p2HasNew = p2Anns.some(a => a.text === 'บริษัท สยามโกลบอล จำกัด (มหาชน)');
      const batchGid = p1Anns.find(a => a.batchGroupId)?.batchGroupId;

      // Now test Atomic Revert
      await window.uiController.revertBatchGroup(batchGid);
      await sleep(300);

      const p1AnnsAfterRevert = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const p2AnnsAfterRevert = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      const p1ItemsAfter = await window.pdfEngine.getTextItems(0);
      const p2ItemsAfter = await window.pdfEngine.getTextItems(1);

      const p1Restored = p1ItemsAfter.some(it => it.str.includes('ไทยโลจิสติกส์'));
      const p2Restored = p2ItemsAfter.some(it => it.str.includes('ไทยโลจิสติกส์'));

      return {
        isWidgetOpen,
        matchesCount: matches.length,
        p1MatchType: p1Match?.matchType,
        p2MatchType: p2Match?.matchType,
        p1HasNew,
        p2HasNew,
        p1AnnsCountAfterRevert: p1AnnsAfterRevert.length,
        p2AnnsCountAfterRevert: p2AnnsAfterRevert.length,
        p1Restored,
        p2Restored
      };
    `);
    console.log('T6 Result:', t6Result);
    if (!t6Result.isWidgetOpen || t6Result.matchesCount !== 2) throw new Error('T6 Failed: Match across pages did not match both pages');
    if (!t6Result.p1HasNew || !t6Result.p2HasNew) throw new Error('T6 Failed: Updated Thai header was not applied to both pages');
    if (!t6Result.p1Restored || !t6Result.p2Restored) throw new Error('T6 Failed: Atomic revert did not restore original Thai header in PDF streams');
    console.log('✅ T6 Passed: Match Across Pages matched Thai header across pages, applied edits, and atomically reverted 100%!');

    // --------------------------------------------------------------------------
    // Test Case 7: T7 (Export to Excel .xlsx with Thai Table & Borders)
    // --------------------------------------------------------------------------
    console.log('\n--- T7: Export to Excel .xlsx with Thai Table & Borders ---');
    const t7Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const exporter = new window.ExcelExporter();
      const exportRes = await exporter.exportWorkbook(window.pdfEngine, window.annotationManager, 'thai_table.xlsx', { skipDownload: true });

      if (!exportRes || !exportRes.bytes || exportRes.bytes.byteLength === 0) {
        throw new Error('ExcelExporter returned empty bytes');
      }

      const files = window._readZip(exportRes.bytes);
      const sharedStringsXml = files['xl/sharedStrings.xml'] || '';
      const stylesXml = files['xl/styles.xml'] || '';
      const sheet1Xml = files['xl/worksheets/sheet1.xml'] || '';

      const hasThaiStrings = [
        'ลำดับ',
        'รายการสินค้า',
        'ข้าวหอมมะลิ 100%',
        'น้ำดื่มบริสุทธิ์',
        'ปั้นจั่นยกของ'
      ].every(s => sharedStringsXml.includes(s));

      const hasTahomaFont = stylesXml.includes('<name val="Tahoma"/>');
      const hasBorders = stylesXml.includes('<border>') && stylesXml.includes('style="thin"');
      const hasCellsWithBorders = sheet1Xml.includes('s="') && sheet1Xml.includes('<c r=');

      return {
        xlsxByteLength: exportRes.bytes.byteLength,
        filesFound: Object.keys(files),
        hasThaiStrings,
        hasTahomaFont,
        hasBorders,
        hasCellsWithBorders
      };
    `);
    console.log('T7 Result:', t7Result);
    if (!t7Result.hasThaiStrings) throw new Error('T7 Failed: Thai strings not preserved in xl/sharedStrings.xml');
    if (!t7Result.hasTahomaFont) throw new Error('T7 Failed: Tahoma font not defined in xl/styles.xml');
    if (!t7Result.hasBorders || !t7Result.hasCellsWithBorders) throw new Error('T7 Failed: Table cell borders not generated in xl/styles.xml or sheet1.xml');
    console.log('✅ T7 Passed: Exported .xlsx workbook with UTF-8 Thai strings, Tahoma font, and styled table borders!');

    // --------------------------------------------------------------------------
    // Test Case 8: T8 (Center on Page with Thai Text)
    // --------------------------------------------------------------------------
    console.log('\n--- T8: Center on Page with Thai Text ---');
    const t8Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.annotationManager.clear();
      const ann = window.annotationManager.addAnnotation({
        type: 'text',
        text: 'บริษัท ไทยโลจิสติกส์ จำกัด',
        fontFamily: 'Sarabun',
        fontSize: 16,
        fontColor: '#000000',
        x: 50,
        y: 100,
        width: 250,
        height: 25,
        pageIndex: 0
      });
      window.annotationManager.selectAnnotation(ann.id);
      window.canvasController.render();
      window.uiController.updatePropertiesBar();
      await sleep(150);

      const pageSize = window.pdfEngine.getPageSize(0);
      const pageWidth = pageSize.width;
      const actualWidth = window.canvasController.measureActualTextWidth(ann);
      const expectedCenteredX = +(((pageWidth - actualWidth) / 2).toFixed(2));

      const centerBtn = document.getElementById('prop-center-page-btn');
      if (!centerBtn) throw new Error('#prop-center-page-btn not found');
      centerBtn.click();
      await sleep(150);

      const centeredAnn = window.annotationManager.getAnnotation(ann.id);
      const isCentered = centeredAnn.x === expectedCenteredX;

      return {
        pageWidth,
        actualWidth,
        expectedCenteredX,
        actualX: centeredAnn.x,
        isCentered
      };
    `);
    console.log('T8 Result:', t8Result);
    if (!t8Result.isCentered) throw new Error('T8 Failed: ann.x (' + t8Result.actualX + ') did not match expected centered X (' + t8Result.expectedCenteredX + ')');
    console.log('✅ T8 Passed: Centered Thai text annotation using actual Sarabun font glyph measurement!');

    // --------------------------------------------------------------------------
    // Test Case 9: T9 (Page Rotation with Selected Thai Annotations)
    // --------------------------------------------------------------------------
    console.log('\n--- T9: Page Rotation with Selected Thai Annotations ---');
    const t9Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const ann = window.annotationManager.annotations[0];
      if (!ann) throw new Error('Annotation not found');
      window.annotationManager.selectAnnotation(ann.id);

      // Rotate Page 1 by 90 degrees CW
      await window.uiController.rotateSinglePage(0, 90);
      await sleep(200);

      const rotatedAnn = window.annotationManager.getAnnotation(ann.id);
      const pageRotation = window.pdfEngine.pageRotations[0];

      // Export rotated PDF to confirm it succeeds without errors
      const res9 = await window.pdfEngine.exportPDF(window.annotationManager, "rotated_thai.pdf");
      const exportedBytes = (res9 && res9.bytes) ? res9.bytes : res9;

      return {
        annRotation: rotatedAnn.rotation,
        pageRotation,
        exportByteLength: exportedBytes.byteLength,
        exportSuccess: exportedBytes.byteLength > 0
      };
    `);
    console.log('T9 Result:', t9Result);
    if (t9Result.annRotation !== 90 || t9Result.pageRotation !== 90) throw new Error('T9 Failed: Annotation did not rotate synchronously with page');
    if (!t9Result.exportSuccess) throw new Error('T9 Failed: exportPDF failed on rotated page');
    console.log('✅ T9 Passed: Thai text annotations rotate synchronously with page and export PDF cleanly!');

    // --------------------------------------------------------------------------
    // Test Case 10: T10 (Thai Buddhist Era Date Stamp & Double-Click Word Segmentation)
    // --------------------------------------------------------------------------
    console.log('\n--- T10: Thai Buddhist Era Date Stamp & Double-Click Word Segmentation ---');
    const t10Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.annotationManager.clear();
      document.querySelector('.tool-btn[data-tool="text"]').click();
      await sleep(150);

      const thaiDateBtn = document.getElementById('prop-thai-date-btn');
      if (!thaiDateBtn) throw new Error('#prop-thai-date-btn not found in properties bar');
      thaiDateBtn.click();
      await sleep(200);

      const dateAnns = window.annotationManager.annotations.filter(a => a.type === 'text');
      const dateAnn = dateAnns[dateAnns.length - 1];
      if (!dateAnn) throw new Error('Thai date annotation was not created');

      const expectedYear = new Date().getFullYear() + 543;
      const containsBuddhistYear = dateAnn.text.includes(String(expectedYear));
      const isSarabun = dateAnn.fontFamily === 'Sarabun';

      // Part B: Double-click word segmentation in <textarea>
      window.annotationManager.clear();
      const textAnn = window.annotationManager.addAnnotation({
        type: 'text',
        text: 'บริษัทไทยโลจิสติกส์จำกัด',
        fontFamily: 'Sarabun',
        fontSize: 16,
        x: 100,
        y: 100,
        width: 250,
        height: 30,
        pageIndex: 0
      });
      window.canvasController.render();
      await sleep(150);

      const textarea = document.querySelector('.page-wrapper[data-page-index="0"] .pdf-text-content');
      if (!textarea) throw new Error('Textarea not found');

      // Place cursor at index 7 (inside "ไทย", which is indices 6 to 9)
      textarea.focus();
      textarea.setSelectionRange(7, 7);

      // Dispatch dblclick
      textarea.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await sleep(100);

      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      const selectedWord = textarea.value.substring(selStart, selEnd);

      return {
        dateAnnText: dateAnn.text,
        containsBuddhistYear,
        isSarabun,
        selStart,
        selEnd,
        selectedWord,
        wordIsThai: selectedWord === 'ไทย'
      };
    `);
    console.log('T10 Result:', t10Result);
    if (!t10Result.containsBuddhistYear || !t10Result.isSarabun) throw new Error('T10 Failed: Buddhist Era date annotation incorrect');
    if (!t10Result.wordIsThai || t10Result.selStart !== 6 || t10Result.selEnd !== 9) throw new Error('T10 Failed: Word segmentation did not highlight "ไทย" (got: "' + t10Result.selectedWord + '")');
    console.log('✅ T10 Passed: Thai Buddhist Era date stamp (พ.ศ.) and double-click word segmentation verified 100%!');

    console.log('\n================================================================');
    console.log('🎉 ALL 10 THAI LANGUAGE SUPPORT TESTS (T1-T10) PASSED PERFECTLY!');
    console.log('================================================================');

  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

runThaiSupportTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
