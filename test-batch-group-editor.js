const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function runBatchGroupEditorTests() {
  console.log('--- Starting Match Across Pages, Batch Group Editor & Atomic Revert Test Suite ---');
  const PORT = 25000 + Math.floor(Math.random() * 4000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-batch-test-');
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
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    const pdfBase64 = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf').toString('base64');

    console.log('1. Loading test_case1.pdf into PDF God...');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      while (!window.uiController || !window.pdfEngine) await sleep(50);
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
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
    // Test Case 1 — Exact 3-Line Header Match Across Pages
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 1: Exact 3-Line Header Match Across Pages ---');
    const tc1Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Click line 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      // Shift-click line 2
      await window._clickText('PO Box 16601', 0, true);
      // Shift-click line 3
      await window._clickText('Tel (604) 583-0006', 0, true);

      const selCount = window.annotationManager.getSelectedAnnotations().length;
      if (selCount !== 3) throw new Error('Expected 3 annotations selected, got ' + selCount);

      // Click "Match Across Pages" button
      const matchBtn = document.getElementById('prop-match-pages-btn');
      if (!matchBtn) throw new Error('#prop-match-pages-btn not found in properties bar');
      matchBtn.click();
      await sleep(300);

      const widget = document.getElementById('batch-group-widget');
      const isOpen = widget && widget.style.display !== 'none';
      const state = window.uiController.activeBatchState;
      const matches = state ? state.matches : [];
      const matchCountBadge = document.getElementById('batch-match-count')?.textContent;

      // Check highlights on Page 1 and Page 2
      const hlP1 = document.querySelectorAll('.page-wrapper[data-page-index="0"] .batch-match-highlight.checked').length;
      const hlP2 = document.querySelectorAll('.page-wrapper[data-page-index="1"] .batch-match-highlight.checked').length;

      return {
        isOpen,
        matchCount: matches.length,
        matchCountBadge,
        matches: matches.map(m => ({ id: m.id, pageIndex: m.pageIndex, matchType: m.matchType, checked: m.checked })),
        hlP1,
        hlP2
      };
    `);
    console.log('Test Case 1 Result:', tc1Result);
    if (!tc1Result.isOpen) throw new Error('Batch Group Widget failed to open!');
    if (tc1Result.matchCount !== 2) throw new Error('Expected 2 matches (Page 1 and Page 2), got ' + tc1Result.matchCount);
    if (tc1Result.hlP1 < 1 || tc1Result.hlP2 < 1) throw new Error('Expected checked highlights on both Page 1 and Page 2!');
    console.log('✅ Test Case 1 Passed: 3-line header matched across Page 1 (source) and Page 2 (exact), widget opened with highlights!');

    // Close widget and clean up for Test Case 2
    await evaluate(`
      window.uiController.closeBatchGroupEditor();
      window.annotationManager.deselectAll();
    `);

    // --------------------------------------------------------------------------
    // Test Case 2 — Duplicate Text in Different Regions (False-Positive Prevention)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 2: Duplicate Text in Different Regions (False-Positive Prevention) ---');
    const tc2Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF to reset and create 2 independent pages of Page 0
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const { PDFDocument } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(u8);
      while (pdfDoc.getPageCount() > 1) pdfDoc.removePage(1);
      const [copied] = await pdfDoc.copyPages(pdfDoc, [0]);
      pdfDoc.addPage(copied);
      const twoPageBytes = await pdfDoc.save();
      await window.uiController.loadPdfBuffer(twoPageBytes.buffer, "test_case1_2pages.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select CAN1033042 at top on Page 0
      const items = await window.pdfEngine.getTextItems(0);
      const canItems = items.filter(it => it.str === 'CAN1033042').sort((a, b) => a.y - b.y);
      const topCan = canItems[0];
      if (!topCan) throw new Error('Top CAN1033042 not found on Page 0');

      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;
      const clickX = rect.left + (topCan.x + 15) * zoom;
      const clickY = rect.top + (topCan.y + 5) * zoom;

      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY }));
      await sleep(200);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      const state = window.uiController.activeBatchState;
      const matches = state ? state.matches : [];

      return {
        topY: topCan.y,
        matches: matches.map(m => ({
          id: m.id,
          pageIndex: m.pageIndex,
          anchorX: m.anchorX,
          anchorY: m.anchorY,
          matchType: m.matchType,
          checked: m.checked
        }))
      };
    `);
    console.log('Test Case 2 Matches:', tc2Result);
    const topMatches = tc2Result.matches.filter(m => Math.abs(m.anchorY - tc2Result.topY) < 5);
    const bottomMatches = tc2Result.matches.filter(m => Math.abs(m.anchorY - tc2Result.topY) >= 18);

    if (topMatches.length < 2 || !topMatches.every(m => m.checked === true && (m.matchType === 'source' || m.matchType === 'exact'))) {
      throw new Error('Expected top CAN1033042 on Page 1 and 2 to have checked: true: ' + JSON.stringify(topMatches));
    }
    if (bottomMatches.length < 1 || !bottomMatches.every(m => m.checked === false && m.matchType === 'out-of-zone')) {
      throw new Error('Expected bottom CAN1033042 to have checked: false and matchType: out-of-zone: ' + JSON.stringify(bottomMatches));
    }
    console.log('✅ Test Case 2 Passed: Exact zone matches checked=true, different position (out-of-zone) checked=false!');

    // Close widget and clean up for Test Case 3
    await evaluate(`
      window.uiController.closeBatchGroupEditor();
      window.annotationManager.deselectAll();
    `);

    // --------------------------------------------------------------------------
    // Test Case 3 — Dedicated Group Editor + Center on Page Across All Pages
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 3: Dedicated Group Editor + Center on Page Across All Pages ---');
    const tc3Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select 3 header lines on Page 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      // Edit the 3 lines in the widget
      const inputs = document.querySelectorAll('#batch-lines-container .batch-line-input');
      const newTexts = [
        "ACME GLOBAL LOGISTICS INC.",
        "100 WATERFRONT ST, VANCOUVER, BC",
        "TEL (604) 555-0199"
      ];
      inputs[0].value = newTexts[0];
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = newTexts[1];
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = newTexts[2];
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));

      // Set alignment to center-page
      const alignSelect = document.getElementById('batch-align-select');
      alignSelect.value = 'center-page';
      alignSelect.dispatchEvent(new Event('change', { bubbles: true }));

      // Apply to all matched pages
      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      // Check results on Page 1 and Page 2
      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      // Helper to count dark pixels in original header location on canvas
      const countHeaderDarkPixels = (pageIndex) => {
        const pageWrapper = document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"]');
        const canvas = pageWrapper.querySelector('.pdf-canvas');
        const ctx = canvas.getContext('2d');
        const zoom = window.uiController.zoom || 1;
        const dpr = window.devicePixelRatio || 1;
        // Bounding box of original header: x: 206..380, y: 25..65
        const sx = Math.floor(206 * zoom * dpr);
        const sy = Math.floor(25 * zoom * dpr);
        const sw = Math.floor(174 * zoom * dpr);
        const sh = Math.floor(40 * zoom * dpr);
        const img = ctx.getImageData(sx, sy, sw, sh);
        let dark = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i + 3] > 100 && (img.data[i] < 150 || img.data[i + 1] < 150 || img.data[i + 2] < 150)) {
            dark++;
          }
        }
        return dark;
      };

      const darkP1 = countHeaderDarkPixels(0);
      const darkP2 = countHeaderDarkPixels(1);

      // Compute expected centered X for each line on Page 1 and Page 2
      const pageWidthP1 = window.pdfEngine.getPageSize(0).width;
      const pageWidthP2 = window.pdfEngine.getPageSize(1).width;

      const checkCentered = (annList, pageWidth) => annList.map(a => {
        const textW = window.canvasController.measureActualTextWidth(a);
        const expectedX = +(((pageWidth - textW) / 2).toFixed(2));
        return {
          text: a.text,
          actualX: a.x,
          expectedX,
          isCentered: Math.abs(a.x - expectedX) <= 0.05
        };
      });

      return {
        darkP1,
        darkP2,
        annsP1Count: annsP1.length,
        annsP2Count: annsP2.length,
        centeredP1: checkCentered(annsP1, pageWidthP1),
        centeredP2: checkCentered(annsP2, pageWidthP2)
      };
    `);
    console.log('Test Case 3 Result:', tc3Result);
    if (tc3Result.darkP1 !== 0 || tc3Result.darkP2 !== 0) {
      throw new Error(`Expected 0 dark pixels in original header on Page 1 & 2, got P1=${tc3Result.darkP1}, P2=${tc3Result.darkP2}`);
    }
    if (tc3Result.annsP1Count !== 3 || tc3Result.annsP2Count !== 3) {
      throw new Error(`Expected 3 annotations on both pages, got P1=${tc3Result.annsP1Count}, P2=${tc3Result.annsP2Count}`);
    }
    if (!tc3Result.centeredP1.every(c => c.isCentered) || !tc3Result.centeredP2.every(c => c.isCentered)) {
      throw new Error('Annotations are not accurately centered: ' + JSON.stringify(tc3Result));
    }
    console.log('✅ Test Case 3 Passed: Header ink redacted on both pages (0 dark pixels) and all 3 lines centered on both pages!');

    // --------------------------------------------------------------------------
    // Test Case 4 — Partial Page Opt-Out (User Unchecks Page 2)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 4: Partial Page Opt-Out (User Unchecks Page 2) ---');
    const tc4Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select 3 header lines on Page 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      // Uncheck Page 2
      const chkP2 = document.querySelector('#batch-matches-list .batch-match-checkbox[data-match-id*="p1"]');
      if (!chkP2) throw new Error('Page 2 checkbox not found');
      chkP2.checked = false;
      chkP2.dispatchEvent(new Event('change', { bubbles: true }));

      // Edit Line 1
      const input0 = document.querySelector('#batch-lines-container .batch-line-input[data-line-index="0"]');
      input0.value = "ONLY PAGE 1 EDITED";
      input0.dispatchEvent(new Event('input', { bubbles: true }));

      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');
      const itemsP2 = await window.pdfEngine.getTextItems(1);
      const originalHeaderStillOnP2 = itemsP2.some(it => it.str === 'GOODRICH TERMINAL 2012 LTD');

      return {
        annsP1Count: annsP1.length,
        annsP2Count: annsP2.length,
        originalHeaderStillOnP2,
        firstLineP1: annsP1[0]?.text
      };
    `);
    console.log('Test Case 4 Result:', tc4Result);
    if (tc4Result.annsP1Count !== 3 || tc4Result.firstLineP1 !== "ONLY PAGE 1 EDITED") {
      throw new Error('Page 1 was not updated properly: ' + JSON.stringify(tc4Result));
    }
    if (tc4Result.annsP2Count !== 0 || !tc4Result.originalHeaderStillOnP2) {
      throw new Error('Page 2 was modified even though it was unchecked: ' + JSON.stringify(tc4Result));
    }
    console.log('✅ Test Case 4 Passed: Unchecked Page 2 remained completely untouched!');

    // --------------------------------------------------------------------------
    // Test Case 5 — Replacing 3 Lines with 2 Lines
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 5: Replacing 3 Lines with 2 Lines ---');
    const tc5Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select 3 header lines on Page 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      // Clear line 3
      const clearBtn2 = document.querySelector('.btn-batch-clear-line[data-line-index="2"]');
      if (clearBtn2) clearBtn2.click();

      // Also set input 2 to empty string
      const inputs = document.querySelectorAll('#batch-lines-container .batch-line-input');
      inputs[0].value = "TWO LINE HEADER LINE 1";
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = "TWO LINE HEADER LINE 2";
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = "";
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));

      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      // Verify that all 3 original items were redacted from PDF on Page 2
      const itemsP2 = await window.pdfEngine.getTextItems(1);
      const originalHeaderP2 = itemsP2.filter(it => it.str.includes('GOODRICH') || it.str.includes('PO Box') || it.str.includes('Tel (604)'));

      return {
        annsP1Count: annsP1.length,
        annsP2Count: annsP2.length,
        originalHeaderP2Count: originalHeaderP2.length,
        p1Texts: annsP1.map(a => a.text),
        p2Texts: annsP2.map(a => a.text)
      };
    `);
    console.log('Test Case 5 Result:', tc5Result);
    if (tc5Result.annsP1Count !== 2 || tc5Result.annsP2Count !== 2) {
      throw new Error(`Expected 2 text annotations per page, got P1=${tc5Result.annsP1Count}, P2=${tc5Result.annsP2Count}`);
    }
    if (tc5Result.originalHeaderP2Count !== 0) {
      throw new Error('Expected all 3 original lines redacted from Page 2 PDF: ' + JSON.stringify(tc5Result));
    }
    console.log('✅ Test Case 5 Passed: 3 lines replaced with 2 lines, original 3rd line redacted from PDF and only 2 annotations created per page!');

    // --------------------------------------------------------------------------
    // Test Case 6 — LocalStorage Snippet Save, Reload, and Reuse
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 6: LocalStorage Snippet Save, Reload, and Reuse ---');
    const tc6Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Re-open widget if closed
      const anns = window.annotationManager.getSelectedAnnotations();
      if (anns.length === 0) {
        const allAnns = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
        window.annotationManager.selectedAnnotationIds = new Set(allAnns.map(a => a.id));
        window.annotationManager.selectedAnnotationId = allAnns[0].id;
        window.annotationManager.notifySelection();
      }
      document.getElementById('prop-match-pages-btn').click();
      await sleep(200);

      // Fill in snippet name and set styling
      const nameInput = document.getElementById('batch-snippet-name');
      nameInput.value = "Vancouver HQ";
      document.getElementById('batch-align-select').value = "center-page";
      document.getElementById('batch-font-family').value = "Times New Roman";
      document.getElementById('batch-font-size').value = "18";

      // Save snippet
      document.getElementById('btn-batch-save-snippet').click();
      await sleep(100);

      const rawStorage = localStorage.getItem('pdfgod_text_snippets_v1');
      const parsed = JSON.parse(rawStorage || '[]');
      const savedSnippet = parsed.find(s => s.name === "Vancouver HQ");

      // Now clear fields / change values in form
      document.getElementById('batch-font-family').value = "Arial";
      document.getElementById('batch-font-size').value = "10";
      document.getElementById('batch-align-select').value = "left";

      // Select Vancouver HQ from dropdown and click Load
      const select = document.getElementById('batch-snippet-select');
      select.value = savedSnippet.id;
      document.getElementById('btn-batch-load-snippet').click();
      await sleep(100);

      const loadedFamily = document.getElementById('batch-font-family').value;
      const loadedSize = document.getElementById('batch-font-size').value;
      const loadedAlign = document.getElementById('batch-align-select').value;

      return {
        hasLocalStorage: !!savedSnippet,
        snippetLines: savedSnippet?.lines,
        loadedFamily,
        loadedSize,
        loadedAlign
      };
    `);
    console.log('Test Case 6 Result:', tc6Result);
    if (!tc6Result.hasLocalStorage) {
      throw new Error('Snippet "Vancouver HQ" was not found in localStorage pdfgod_text_snippets_v1');
    }
    if (tc6Result.loadedFamily !== "Times New Roman" || tc6Result.loadedSize !== "18" || tc6Result.loadedAlign !== "center-page") {
      throw new Error('Loaded snippet values did not populate accurately: ' + JSON.stringify(tc6Result));
    }
    console.log('✅ Test Case 6 Passed: Snippet saved to localStorage and loaded back into widget with accurate values!');

    // --------------------------------------------------------------------------
    // Test Case 7 — Full Atomic Revert
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 7: Full Atomic Revert ---');
    const tc7Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select 3 header lines on Page 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      // Edit lines and apply
      const inputs = document.querySelectorAll('#batch-lines-container .batch-line-input');
      inputs[0].value = "BRAND NEW COMPANY NAME";
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      const annsBeforeRevert = window.annotationManager.annotations.length;

      // Click Revert Group button in properties bar (or in widget)
      const revertGroupBtn = document.getElementById('prop-revert-group-btn') || document.getElementById('btn-batch-revert');
      if (!revertGroupBtn) throw new Error('Revert Group button not found');
      revertGroupBtn.click();
      await sleep(500);

      // Check that batch annotations were removed on both Page 1 and Page 2
      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      // Check that original PDF header is restored in getTextItems(0) and getTextItems(1)
      const itemsP1 = await window.pdfEngine.getTextItems(0);
      const itemsP2 = await window.pdfEngine.getTextItems(1);

      const hasGoodrichP1 = itemsP1.some(it => it.str === 'GOODRICH TERMINAL 2012 LTD');
      const hasGoodrichP2 = itemsP2.some(it => it.str === 'GOODRICH TERMINAL 2012 LTD');

      // Check canvas dark pixels in original header location
      const countHeaderDarkPixels = (pageIndex) => {
        const pageWrapper = document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"]');
        const canvas = pageWrapper.querySelector('.pdf-canvas');
        const ctx = canvas.getContext('2d');
        const zoom = window.uiController.zoom || 1;
        const dpr = window.devicePixelRatio || 1;
        const sx = Math.floor(206 * zoom * dpr);
        const sy = Math.floor(25 * zoom * dpr);
        const sw = Math.floor(174 * zoom * dpr);
        const sh = Math.floor(40 * zoom * dpr);
        const img = ctx.getImageData(sx, sy, sw, sh);
        let dark = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i + 3] > 100 && (img.data[i] < 150 || img.data[i + 1] < 150 || img.data[i + 2] < 150)) {
            dark++;
          }
        }
        return dark;
      };

      const darkP1 = countHeaderDarkPixels(0);
      const darkP2 = countHeaderDarkPixels(1);

      return {
        annsBeforeRevert,
        annsP1Count: annsP1.length,
        annsP2Count: annsP2.length,
        hasGoodrichP1,
        hasGoodrichP2,
        darkP1,
        darkP2
      };
    `);
    console.log('Test Case 7 Result:', tc7Result);
    if (tc7Result.annsP1Count !== 0 || tc7Result.annsP2Count !== 0) {
      throw new Error(`Expected 0 annotations after revert, got P1=${tc7Result.annsP1Count}, P2=${tc7Result.annsP2Count}`);
    }
    if (!tc7Result.hasGoodrichP1 || !tc7Result.hasGoodrichP2) {
      throw new Error('Original PDF header was not restored in getTextItems: ' + JSON.stringify(tc7Result));
    }
    if (tc7Result.darkP1 === 0 || tc7Result.darkP2 === 0) {
      throw new Error('Original header ink was not rendered back onto the canvas: ' + JSON.stringify(tc7Result));
    }
    console.log('✅ Test Case 7 Passed: Batch annotations removed and original PDF text & ink 100% restored across all pages!');

    // --------------------------------------------------------------------------
    // Test Case 8 — Interactive Preview Per-Line Positioning (Moving Line 2 Up/Right Independently)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 8: Interactive Preview Per-Line Positioning (Moving Line 2 Up/Right Independently) ---');
    const tc8Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // Select 3 header lines on Page 1
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(300);

      const stateBefore = window.uiController.activeBatchState;
      const initLine2Dx = stateBefore.lines[1].dx;
      const initLine2Dy = stateBefore.lines[1].dy;

      // Click only Line 2 in #batch-preview-stage
      const previewItem2 = document.querySelector('#batch-preview-stage .batch-preview-item[data-line-index="1"]');
      if (!previewItem2) throw new Error('Preview item for line 2 not found');
      previewItem2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(100);

      // Verify line 2 is selected
      const selIndices = Array.from(window.uiController.activeBatchState.selectedLineIndices);
      if (selIndices.length !== 1 || selIndices[0] !== 1) {
        throw new Error('Expected only Line 2 selected, got: ' + JSON.stringify(selIndices));
      }

      // Press ArrowUp (-5px dy) and Shift+ArrowRight (+1px dx)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      await sleep(100);

      const line1Dx = window.uiController.activeBatchState.lines[0].dx;
      const line1Dy = window.uiController.activeBatchState.lines[0].dy;
      const line2Dx = window.uiController.activeBatchState.lines[1].dx;
      const line2Dy = window.uiController.activeBatchState.lines[1].dy;
      const line3Dx = window.uiController.activeBatchState.lines[2].dx;
      const line3Dy = window.uiController.activeBatchState.lines[2].dy;

      // Apply to all matched pages
      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      return {
        initLine2Dx,
        initLine2Dy,
        line1Dx,
        line1Dy,
        line2Dx,
        line2Dy,
        line3Dx,
        line3Dy,
        annsP1: annsP1.map(a => ({ text: a.text, x: a.x, y: a.y })),
        annsP2: annsP2.map(a => ({ text: a.text, x: a.x, y: a.y }))
      };
    `);
    console.log('Test Case 8 Result:', tc8Result);
    if (tc8Result.line2Dy !== +(tc8Result.initLine2Dy - 5).toFixed(2) || tc8Result.line2Dx !== +(tc8Result.initLine2Dx + 1).toFixed(2)) {
      throw new Error(`Line 2 offset was not updated accurately: expected dy=${tc8Result.initLine2Dy - 5}, dx=${tc8Result.initLine2Dx + 1}, got dy=${tc8Result.line2Dy}, dx=${tc8Result.line2Dx}`);
    }
    if (tc8Result.line1Dy !== 0) throw new Error('Line 1 dy changed unexpectedly: ' + tc8Result.line1Dy);

    const p1L1 = tc8Result.annsP1[0];
    const p1L2 = tc8Result.annsP1[1];
    const p2L1 = tc8Result.annsP2[0];
    const p2L2 = tc8Result.annsP2[1];

    if (Math.abs((p1L2.y - p1L1.y) - tc8Result.line2Dy) > 0.1 || Math.abs((p2L2.y - p2L1.y) - tc8Result.line2Dy) > 0.1) {
      throw new Error('Applied annotation vertical spacing does not match Line 2 dy shift: ' + JSON.stringify(tc8Result));
    }
    if (Math.abs((p1L2.x - p1L1.x) - tc8Result.line2Dx) > 0.1 || Math.abs((p2L2.x - p2L1.x) - tc8Result.line2Dx) > 0.1) {
      throw new Error('Applied annotation horizontal spacing does not match Line 2 dx shift: ' + JSON.stringify(tc8Result));
    }
    console.log('✅ Test Case 8 Passed: Line 2 moved up by 5pt and right by 1pt independently and applied to both pages!');

    // --------------------------------------------------------------------------
    // Test Case 9 — Saving & Loading Snippet Preserves Per-Line Relative (dx, dy) and Per-Line Font Styles
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 9: Saving & Loading Snippet Preserves Per-Line Relative (dx, dy) and Per-Line Font Styles ---');
    const tc9Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const anns = window.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      if (anns.length === 0) {
        const p1Anns = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
        window.annotationManager.selectedAnnotationIds = new Set(p1Anns.map(a => a.id));
        window.annotationManager.selectedAnnotationId = p1Anns[0].id;
        window.annotationManager.notifySelection();
      }
      document.getElementById('prop-match-pages-btn').click();
      await sleep(200);

      // Configure Line 1 as 14pt Bold
      window.uiController.activeBatchState.selectedLineIndices = new Set([0]);
      window.uiController.renderBatchPreviewStage();
      document.getElementById('batch-font-family').value = 'Helvetica';
      document.getElementById('batch-font-size').value = '14';
      document.getElementById('batch-font-size').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('batch-bold-btn').classList.add('active');
      document.getElementById('batch-italic-btn').classList.remove('active');
      window.uiController.updateActiveLinesStyle({ fontFamily: 'Helvetica', fontSize: 14, fontWeight: 'bold', fontStyle: 'normal' });

      // Configure Line 2 at custom relative offset (dx: 12, dy: 9) with 9pt Normal
      window.uiController.activeBatchState.selectedLineIndices = new Set([1]);
      window.uiController.renderBatchPreviewStage();
      const l1 = window.uiController.activeBatchState.lines[0];
      const l2 = window.uiController.activeBatchState.lines[1];
      l2.dx = +( (l1.dx || 0) + 12 ).toFixed(2);
      l2.dy = +( (l1.dy || 0) + 9 ).toFixed(2);
      window.uiController.updateActiveLinesStyle({ fontFamily: 'Arial', fontSize: 9, fontWeight: 'normal', fontStyle: 'normal' });

      // Configure Line 3 at (dx: 24, dy: 20) with 8pt Italic
      window.uiController.activeBatchState.selectedLineIndices = new Set([2]);
      window.uiController.renderBatchPreviewStage();
      const l3 = window.uiController.activeBatchState.lines[2];
      l3.dx = +( (l1.dx || 0) + 24 ).toFixed(2);
      l3.dy = +( (l1.dy || 0) + 20 ).toFixed(2);
      window.uiController.updateActiveLinesStyle({ fontFamily: 'Times New Roman', fontSize: 8, fontWeight: 'normal', fontStyle: 'italic' });

      window.uiController.renderBatchPreviewStage();
      window.uiController.renderBatchMatchHighlights();

      // Save snippet as "Custom Relative Header"
      const nameInput = document.getElementById('batch-snippet-name');
      nameInput.value = "Custom Relative Header";
      document.getElementById('btn-batch-save-snippet').click();
      await sleep(100);

      const rawStorage = localStorage.getItem('pdfgod_text_snippets_v1');
      const parsed = JSON.parse(rawStorage || '[]');
      const savedSnippet = parsed.find(s => s.name === "Custom Relative Header");

      // Reset lines to flat 0/0 and default fonts
      window.uiController.activeBatchState.lines.forEach(l => {
        l.dx = 0;
        l.dy = 0;
        l.fontSize = 12;
        l.fontWeight = 'normal';
        l.fontStyle = 'normal';
      });

      // Load snippet from dropdown
      const select = document.getElementById('batch-snippet-select');
      select.value = savedSnippet.id;
      document.getElementById('btn-batch-load-snippet').click();
      await sleep(100);

      const loadedLines = window.uiController.activeBatchState.lines;

      // Apply to verify annotations get positioned accurately
      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      const annsP1 = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2 = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      return {
        savedSnippet,
        loadedLines: loadedLines.map(l => ({ text: l.currentText, dx: l.dx, dy: l.dy, fontSize: l.fontSize, fontWeight: l.fontWeight, fontStyle: l.fontStyle, fontFamily: l.fontFamily })),
        annsP1: annsP1.map(a => ({ text: a.text, x: a.x, y: a.y, fontSize: a.fontSize, fontWeight: a.fontWeight, fontStyle: a.fontStyle })),
        annsP2: annsP2.map(a => ({ text: a.text, x: a.x, y: a.y, fontSize: a.fontSize, fontWeight: a.fontWeight, fontStyle: a.fontStyle }))
      };
    `);
    console.log('Test Case 9 Result:', tc9Result);
    const lines = tc9Result.loadedLines;
    if (lines[0].dx !== 0 || lines[0].dy !== 0 || lines[0].fontSize !== 14 || lines[0].fontWeight !== 'bold') {
      throw new Error('Line 1 did not restore relative dx/dy or font accurately: ' + JSON.stringify(lines[0]));
    }
    if (lines[1].dx !== 12 || lines[1].dy !== 9 || lines[1].fontSize !== 9 || lines[1].fontWeight !== 'normal') {
      throw new Error('Line 2 did not restore relative dx/dy or font accurately: ' + JSON.stringify(lines[1]));
    }
    if (lines[2].dx !== 24 || lines[2].dy !== 20 || lines[2].fontSize !== 8 || lines[2].fontStyle !== 'italic') {
      throw new Error('Line 3 did not restore relative dx/dy or font accurately: ' + JSON.stringify(lines[2]));
    }
    console.log('✅ Test Case 9 Passed: Snippet restored per-line relative (dx, dy) and per-line font styling accurately!');

    // --------------------------------------------------------------------------
    // Test Case 10 — Re-Editing an Already Applied Group Across Pages (#prop-edit-group-btn)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 10: Re-Editing an Already Applied Group Across Pages (#prop-edit-group-btn) ---');
    const tc10Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.uiController.closeBatchGroupEditor();
      await sleep(100);

      // Select an applied annotation on Page 1
      const p1Anns = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      window.annotationManager.selectAnnotation(p1Anns[0].id, false);
      await sleep(150);

      const editBtn = document.getElementById('prop-edit-group-btn');
      if (!editBtn) throw new Error('#prop-edit-group-btn not visible in properties bar for applied batch group');

      // Click Edit Group
      editBtn.click();
      await sleep(300);

      const isWidgetOpen = document.getElementById('batch-group-widget').style.display !== 'none';
      const isReedit = window.uiController.activeBatchState?.isReedit;

      // Select Line 2 in preview stage
      const previewItem2 = document.querySelector('#batch-preview-stage .batch-preview-item[data-line-index="1"]');
      if (!previewItem2) throw new Error('Line 2 preview item not found');
      previewItem2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(100);

      const line2DyBefore = window.uiController.activeBatchState.lines[1].dy;

      // Nudge Line 2 up by another -3pt (3x Shift+ArrowUp)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
      await sleep(100);

      const line2DyAfter = window.uiController.activeBatchState.lines[1].dy;

      // Click Apply
      document.getElementById('btn-batch-apply').click();
      await sleep(500);

      // Check annotations on Page 1 and Page 2
      const annsP1After = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2After = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');

      // Now click Revert Group
      const revertBtn = document.getElementById('prop-revert-group-btn') || document.getElementById('btn-batch-revert');
      if (!revertBtn) throw new Error('Revert Group button not found');
      revertBtn.click();
      await sleep(500);

      const annsP1Reverted = window.annotationManager.getAnnotationsForPage(0).filter(a => a.type === 'text');
      const annsP2Reverted = window.annotationManager.getAnnotationsForPage(1).filter(a => a.type === 'text');
      const itemsP1 = await window.pdfEngine.getTextItems(0);
      const itemsP2 = await window.pdfEngine.getTextItems(1);
      const hasGoodrichP1 = itemsP1.some(it => it.str === 'GOODRICH TERMINAL 2012 LTD');
      const hasGoodrichP2 = itemsP2.some(it => it.str === 'GOODRICH TERMINAL 2012 LTD');

      return {
        isWidgetOpen,
        isReedit,
        line2DyBefore,
        line2DyAfter,
        annsP1Count: annsP1After.length,
        annsP2Count: annsP2After.length,
        p1Line2Y: annsP1After[1]?.y,
        p2Line2Y: annsP2After[1]?.y,
        annsP1RevertedCount: annsP1Reverted.length,
        annsP2RevertedCount: annsP2Reverted.length,
        hasGoodrichP1,
        hasGoodrichP2
      };
    `);
    console.log('Test Case 10 Result:', tc10Result);
    if (!tc10Result.isWidgetOpen || !tc10Result.isReedit) {
      throw new Error('Re-open Batch Group Editor did not set re-edit mode properly: ' + JSON.stringify(tc10Result));
    }
    if (tc10Result.line2DyAfter !== +(tc10Result.line2DyBefore - 3).toFixed(2)) {
      throw new Error(`Line 2 was not nudged up by 3pt: before=${tc10Result.line2DyBefore}, after=${tc10Result.line2DyAfter}`);
    }
    if (tc10Result.annsP1Count !== 3 || tc10Result.annsP2Count !== 3) {
      throw new Error(`Duplicate or missing annotations after re-edit apply: P1=${tc10Result.annsP1Count}, P2=${tc10Result.annsP2Count}`);
    }
    if (tc10Result.annsP1RevertedCount !== 0 || tc10Result.annsP2RevertedCount !== 0 || !tc10Result.hasGoodrichP1 || !tc10Result.hasGoodrichP2) {
      throw new Error('Atomic revert after re-edit failed to cleanly restore original PDF: ' + JSON.stringify(tc10Result));
    }
    console.log('✅ Test Case 10 Passed: Re-edited group nudged Line 2 without duplicates, and revert restored original PDF text 100%!');

    // --------------------------------------------------------------------------
    // Test Case 11 — Deselect All Lines When Clicking Outside Text Boxes in Preview Stage
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 11: Deselect All Lines When Clicking Outside Text Boxes in Preview Stage ---');
    const tc11Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Select 3 header lines on Page 1 to open Batch Group Editor
      await window._clickText('GOODRICH TERMINAL 2012 LTD', 0, false);
      await window._clickText('PO Box 16601', 0, true);
      await window._clickText('Tel (604) 583-0006', 0, true);
      await sleep(150);

      document.getElementById('prop-match-pages-btn').click();
      await sleep(250);

      const stage = document.getElementById('batch-preview-stage');
      if (!stage) throw new Error('#batch-preview-stage not found');

      // Initially Line 0 is selected by default
      const initialSelCount = window.uiController.activeBatchState?.selectedLineIndices?.size || 0;
      const initialDomSelCount = stage.querySelectorAll('.batch-preview-item.selected').length;

      // Dispatch pointerdown on empty area of stage (not on .batch-preview-item)
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(100);

      const selAfterClickOutside = window.uiController.activeBatchState?.selectedLineIndices?.size;
      const domSelAfterClickOutside = stage.querySelectorAll('.batch-preview-item.selected').length;
      const coordsText = document.getElementById('batch-coords-label')?.textContent || '';

      // Test saving a snippet while nothing is selected: lines must preserve individual fonts!
      // First modify Line 0 style directly on the object to verify it isn't overwritten by toolbar
      const line0 = window.uiController.activeBatchState.lines[0];
      line0.fontFamily = 'Helvetica';
      line0.fontSize = 14;

      // Change toolbar inputs to something different without selecting anything
      document.getElementById('batch-font-family').value = 'Courier New';
      document.getElementById('batch-font-size').value = '28';

      // Save snippet
      document.getElementById('batch-snippet-name').value = "Preserved Unselected Snippet";
      document.getElementById('btn-batch-save-snippet').click();
      await sleep(100);

      const rawStorage = localStorage.getItem('pdfgod_text_snippets_v1');
      const parsed = JSON.parse(rawStorage || '[]');
      const savedSnippet = parsed.find(s => s.name === "Preserved Unselected Snippet");

      // Now click on Line 2 preview item to verify re-selection works
      const previewItem2 = stage.querySelector('.batch-preview-item[data-line-index="1"]');
      previewItem2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(100);

      const reselectedCount = window.uiController.activeBatchState?.selectedLineIndices?.size;
      const reselectedLine = Array.from(window.uiController.activeBatchState?.selectedLineIndices || [])[0];

      // Click outside again
      stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(100);

      const finalSelCount = window.uiController.activeBatchState?.selectedLineIndices?.size;
      const finalDomCount = stage.querySelectorAll('.batch-preview-item.selected').length;

      window.uiController.closeBatchGroupEditor();

      return {
        initialSelCount,
        initialDomSelCount,
        selAfterClickOutside,
        domSelAfterClickOutside,
        coordsText,
        savedSnippet,
        reselectedCount,
        reselectedLine,
        finalSelCount,
        finalDomCount
      };
    `);
    console.log('Test Case 11 Result:', tc11Result);
    if (tc11Result.initialSelCount === 0 || tc11Result.initialDomSelCount === 0) {
      throw new Error('Initial line selection failed: ' + JSON.stringify(tc11Result));
    }
    if (tc11Result.selAfterClickOutside !== 0 || tc11Result.domSelAfterClickOutside !== 0) {
      throw new Error(`Clicking outside did not clear selection: state=${tc11Result.selAfterClickOutside}, dom=${tc11Result.domSelAfterClickOutside}`);
    }
    if (!tc11Result.coordsText.toLowerCase().includes('no line selected')) {
      throw new Error(`Coordinates label did not update to 'No line selected': got "${tc11Result.coordsText}"`);
    }
    if (!tc11Result.savedSnippet) {
      throw new Error('Saved snippet was not found in localStorage');
    }
    const snipL0 = tc11Result.savedSnippet.lines[0];
    if (snipL0.fontFamily === 'Courier New' || snipL0.fontSize === 28) {
      throw new Error('Line 0 style was overwritten by toolbar inputs when no line was selected: ' + JSON.stringify(snipL0));
    }
    if (snipL0.fontFamily !== 'Helvetica' || snipL0.fontSize !== 14) {
      throw new Error('Line 0 did not preserve its original font styling: ' + JSON.stringify(snipL0));
    }
    if (tc11Result.reselectedCount !== 1 || tc11Result.reselectedLine !== 1) {
      throw new Error('Re-selection of Line 2 failed: ' + JSON.stringify(tc11Result));
    }
    if (tc11Result.finalSelCount !== 0 || tc11Result.finalDomCount !== 0) {
      throw new Error('Second click outside failed to clear selection: ' + JSON.stringify(tc11Result));
    }
    console.log('✅ Test Case 11 Passed: Clicking outside deselects all lines, label updates cleanly, and unselected snippet saving preserves line fonts!');

    // --------------------------------------------------------------------------
    // Test Case 12 — Marquee Rectangle Selection, Group Duplicate, Group Delete & No Dup/Del/Whiteout Buttons
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 12: Marquee Selection, Group Copy/Paste, Group Delete & Clean Properties Bar ---');
    const tc12Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Reload fresh PDF
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);
      await window.canvasController.loadTextItemsForActivePage();

      const pageWrapper = document.querySelector('.page-wrapper[data-page-index="0"]');
      const layer = pageWrapper.querySelector('.annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;

      // Start drag at PDF coords (190, 10) -> End at (390, 55)
      const startX = rect.left + 190 * zoom;
      const startY = rect.top + 10 * zoom;
      const endX = rect.left + 390 * zoom;
      const endY = rect.top + 55 * zoom;

      // Perform marquee drag over the 3 header lines
      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0 }));
      await sleep(50);
      layer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: endX, clientY: endY, button: 0 }));
      await sleep(50);
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: endX, clientY: endY, button: 0 }));
      await sleep(600);

      const selectedAfterMarquee = window.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      const totalAnnsAfterMarquee = window.annotationManager.annotations.length;

      // Check properties bar buttons
      const hasDupBtn = !!document.getElementById('prop-dup-btn');
      const hasDelBtn = !!document.getElementById('prop-del-btn');
      const hasWhiteoutBtn = !!document.getElementById('prop-whiteout-btn');

      // Duplicate the selected 3 lines with Ctrl+C -> Ctrl+V
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(100);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(300);

      const totalAnnsAfterPaste = window.annotationManager.annotations.length;
      const selectedAfterPaste = window.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');

      // Delete the 3 pasted duplicates with Delete key
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      await sleep(300);

      const totalAnnsAfterDelete = window.annotationManager.annotations.length;

      // Select the remaining 3 lines and delete with Backspace key
      const remaining = window.annotationManager.annotations.filter(a => a.type === 'text');
      window.annotationManager.selectedAnnotationIds = new Set(remaining.map(a => a.id));
      window.annotationManager.selectedAnnotationId = remaining[0]?.id || null;
      window.annotationManager.notifySelection();
      await sleep(100);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      await sleep(300);

      const finalAnnsCount = window.annotationManager.annotations.length;

      return {
        selectedAfterMarqueeCount: selectedAfterMarquee.length,
        totalAnnsAfterMarquee,
        hasDupBtn,
        hasDelBtn,
        hasWhiteoutBtn,
        totalAnnsAfterPaste,
        selectedAfterPasteCount: selectedAfterPaste.length,
        totalAnnsAfterDelete,
        finalAnnsCount
      };
    `);
    console.log('Test Case 12 Result:', tc12Result);
    if (tc12Result.selectedAfterMarqueeCount !== 3 || tc12Result.totalAnnsAfterMarquee !== 3) {
      throw new Error(`Marquee selection failed: selected=${tc12Result.selectedAfterMarqueeCount}, total=${tc12Result.totalAnnsAfterMarquee}`);
    }
    if (tc12Result.hasDupBtn || tc12Result.hasDelBtn || tc12Result.hasWhiteoutBtn) {
      throw new Error(`Properties bar still contains removed buttons: dup=${tc12Result.hasDupBtn}, del=${tc12Result.hasDelBtn}, whiteout=${tc12Result.hasWhiteoutBtn}`);
    }
    if (tc12Result.totalAnnsAfterPaste !== 6 || tc12Result.selectedAfterPasteCount !== 3) {
      throw new Error(`Group copy/paste failed: total=${tc12Result.totalAnnsAfterPaste}, selected=${tc12Result.selectedAfterPasteCount}`);
    }
    if (tc12Result.totalAnnsAfterDelete !== 3) {
      throw new Error(`Group delete with Delete key failed: expected 3, got ${tc12Result.totalAnnsAfterDelete}`);
    }
    if (tc12Result.finalAnnsCount !== 0) {
      throw new Error(`Group delete with Backspace key failed: expected 0, got ${tc12Result.finalAnnsCount}`);
    }
    console.log('✅ Test Case 12 Passed: Marquee rectangle selection, group copy/paste, group delete, and clean text properties bar verified 100%!');

    // --------------------------------------------------------------------------
    // Test Case 13 — Vector Line Selection in Groups & Arrow / Clipboard Manipulation
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 13: Vector Line Selection in Groups & Arrow / Clipboard Manipulation ---');
    const tc13Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Reload fresh PDF buffer
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);

      // PART A: In 'edit-pdf-text' mode, marquee over (10, 75) to (200, 115)
      // Must select ONLY text ('Delivery Slip') and NO vector lines.
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;

      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 10 * zoom, clientY: rect.top + 75 * zoom
      }));
      layer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      }));
      await window.uiController.canvasController.handlePointerUp({
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      });
      await sleep(300);

      const partASelected = window.annotationManager.getSelectedAnnotations();
      const partATextCount = partASelected.filter(a => a.type === 'text').length;
      const partALineCount = partASelected.filter(a => a.type === 'line').length;

      // Reset buffer cleanly for PART B
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);

      // PART B: In 'select' mode, marquee over (10, 75) to (200, 115)
      // Must select BOTH text ('Delivery Slip') AND vector line!
      document.querySelector('.tool-btn[data-tool="select"]').click();
      await sleep(200);

      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 10 * zoom, clientY: rect.top + 75 * zoom
      }));
      layer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      }));
      await window.uiController.canvasController.handlePointerUp({
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      });
      await sleep(300);

      const partBSelected = window.annotationManager.getSelectedAnnotations();
      const partBText = partBSelected.find(a => a.type === 'text');
      const partBLine = partBSelected.find(a => a.type === 'line');

      // Verify canvas blue selection highlight around the selected vector line
      const annCanvas = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-canvas:not(.preview)');
      const annCtx = annCanvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;

      const lineMinX = Math.min(partBLine.x, partBLine.x + (partBLine.width || 0));
      const lineMinY = Math.min(partBLine.y, partBLine.y + (partBLine.height || 0));
      const lineBoxW = Math.max(Math.abs(partBLine.width || 0) + 12, 10);
      const lineBoxH = Math.max(Math.abs(partBLine.height || 0) + 12, 10);
      const sampleX = Math.round((lineMinX - 5) * zoom * dpr);
      const sampleY = Math.round((lineMinY - 5) * zoom * dpr);
      const sampleW = Math.round(lineBoxW * zoom * dpr);
      const sampleH = Math.round(lineBoxH * zoom * dpr);

      const countBluePixels = () => {
        const img = annCtx.getImageData(Math.max(0, sampleX), Math.max(0, sampleY), Math.min(sampleW, annCanvas.width - sampleX), Math.min(sampleH, annCanvas.height - sampleY));
        let count = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          const r = img.data[i], g = img.data[i+1], b = img.data[i+2], a = img.data[i+3];
          if (a > 30 && b > 180 && b > r + 40 && b > g + 40) count++;
        }
        return count;
      };

      const bluePixelsWhenSelected = countBluePixels();

      // Click on empty space (x: 500, y: 50) to deselect everything
      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 500 * zoom, clientY: rect.top + 50 * zoom
      }));
      layer.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 500 * zoom, clientY: rect.top + 50 * zoom
      }));
      await sleep(150);

      const selectedCountAfterClickOutside = window.annotationManager.getSelectedAnnotations().length;
      const bluePixelsAfterClickOutside = countBluePixels();

      // Re-select both text & line to continue with Part C
      window.annotationManager.selectedAnnotationIds = new Set([partBText.id, partBLine.id]);
      window.annotationManager.selectedAnnotationId = partBText.id;
      window.annotationManager.notifySelection();
      await sleep(150);

      const initTextX = partBText ? partBText.x : null;
      const initTextY = partBText ? partBText.y : null;
      const initLineX = partBLine ? partBLine.x : null;
      const initLineY = partBLine ? partBLine.y : null;

      // PART C: Move both with Arrow keys
      // ArrowDown (normal key = 5px)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      // Shift+ArrowRight (shift key = 1px)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      await sleep(150);

      const afterMoveTextX = partBText ? partBText.x : null;
      const afterMoveTextY = partBText ? partBText.y : null;
      const afterMoveLineX = partBLine ? partBLine.x : null;
      const afterMoveLineY = partBLine ? partBLine.y : null;

      // PART D: Duplicate both with Ctrl+C -> Ctrl+V
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(100);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(300);

      const totalAnnsAfterPaste = window.annotationManager.annotations.length;
      const selectedAfterPaste = window.annotationManager.getSelectedAnnotations();
      const pastedTextCount = selectedAfterPaste.filter(a => a.type === 'text').length;
      const pastedLineCount = selectedAfterPaste.filter(a => a.type === 'line').length;

      // PART E: Delete duplicates with Delete key, then delete original with Backspace key
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      await sleep(300);

      const totalAnnsAfterDelete = window.annotationManager.annotations.length;

      // Select original text & line, then press Backspace
      window.annotationManager.selectedAnnotationIds = new Set([partBText.id, partBLine.id]);
      window.annotationManager.selectedAnnotationId = partBText.id;
      window.annotationManager.notifySelection();
      await sleep(100);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      await sleep(300);

      const finalAnnsCount = window.annotationManager.annotations.length;

      return {
        partATextCount,
        partALineCount,
        partBTotalCount: partBSelected.length,
        hasPartBText: !!partBText && partBText.text.includes('Delivery Slip'),
        hasPartBLine: !!partBLine && Math.abs(initLineY - 104.4) < 1,
        bluePixelsWhenSelected,
        selectedCountAfterClickOutside,
        bluePixelsAfterClickOutside,
        textDx: +(afterMoveTextX - initTextX).toFixed(2),
        textDy: +(afterMoveTextY - initTextY).toFixed(2),
        lineDx: +(afterMoveLineX - initLineX).toFixed(2),
        lineDy: +(afterMoveLineY - initLineY).toFixed(2),
        totalAnnsAfterPaste,
        pastedTextCount,
        pastedLineCount,
        totalAnnsAfterDelete,
        finalAnnsCount
      };
    `);
    console.log('Test Case 13 Result:', tc13Result);
    if (tc13Result.partATextCount !== 1 || tc13Result.partALineCount !== 0) {
      throw new Error(`Part A failed: edit-pdf-text should select 1 text and 0 lines, got ${tc13Result.partATextCount} texts and ${tc13Result.partALineCount} lines`);
    }
    if (tc13Result.partBTotalCount !== 2 || !tc13Result.hasPartBText || !tc13Result.hasPartBLine) {
      throw new Error(`Part B failed: select tool should select text and vector line, got total=${tc13Result.partBTotalCount}`);
    }
    if (tc13Result.bluePixelsWhenSelected === 0) {
      throw new Error(`Part B failed: expected blue selection pixels when vector line is selected, got 0`);
    }
    if (tc13Result.selectedCountAfterClickOutside !== 0) {
      throw new Error(`Part B failed: clicking empty space should deselect all, got ${tc13Result.selectedCountAfterClickOutside} selected`);
    }
    if (tc13Result.bluePixelsAfterClickOutside !== 0) {
      throw new Error(`Part B failed: clicking empty space must clear blue selection highlight from canvas, got ${tc13Result.bluePixelsAfterClickOutside} blue pixels remaining`);
    }
    if (tc13Result.textDx !== 1 || tc13Result.textDy !== 5 || tc13Result.lineDx !== 1 || tc13Result.lineDy !== 5) {
      throw new Error(`Part C failed: Arrow keys should move text and line by (1, 5), got text=(${tc13Result.textDx}, ${tc13Result.textDy}), line=(${tc13Result.lineDx}, ${tc13Result.lineDy})`);
    }
    if (tc13Result.totalAnnsAfterPaste !== 4 || tc13Result.pastedTextCount !== 1 || tc13Result.pastedLineCount !== 1) {
      throw new Error(`Part D failed: Ctrl+C -> Ctrl+V should duplicate 1 text and 1 line (total 4), got total=${tc13Result.totalAnnsAfterPaste}`);
    }
    if (tc13Result.totalAnnsAfterDelete !== 2 || tc13Result.finalAnnsCount !== 0) {
      throw new Error(`Part E failed: Delete / Backspace keys should delete duplicates and originals, got afterDelete=${tc13Result.totalAnnsAfterDelete}, final=${tc13Result.finalAnnsCount}`);
    }
    console.log('✅ Test Case 13 Passed: Vector lines selectable in groups with text via select tool, ignored by text tool, moved via Arrow keys, duplicated via Ctrl+C/Ctrl+V, and deleted via Delete/Backspace!');

    // --------------------------------------------------------------------------
    // Test Case 14 — Performance Benchmark: High-Volume Marquee & Arrow Nudge (70–90+ items)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 14: Performance Benchmark: High-Volume Marquee & Arrow Nudge ---');
    const tc14Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Reset to select tool and clean annotations
      document.querySelector('.tool-btn[data-tool="select"]').click();
      await sleep(150);
      window.annotationManager.annotations = [];
      window.annotationManager.deselectAll();
      await sleep(100);

      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;

      // Start marquee selection over the entire table area (x: 10 to 600, y: 120 to 700)
      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 10 * zoom, clientY: rect.top + 120 * zoom
      }));
      layer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 600 * zoom, clientY: rect.top + 700 * zoom
      }));

      // Benchmark marquee release (PDF single-pass redaction + DOM batch sync + O(1) indices)
      const t0 = performance.now();
      await window.uiController.canvasController.handlePointerUp({
        clientX: rect.left + 600 * zoom, clientY: rect.top + 700 * zoom
      });
      const marqueeElapsedMs = +(performance.now() - t0).toFixed(2);
      await sleep(100);

      const selectedAnns = window.annotationManager.getSelectedAnnotations();
      const selectedCount = selectedAnns.length;
      const textCount = selectedAnns.filter(a => a.type === 'text').length;
      const lineCount = selectedAnns.filter(a => a.type === 'line').length;

      // Sample initial positions
      const sampleText = selectedAnns.find(a => a.type === 'text');
      const sampleLine = selectedAnns.find(a => a.type === 'line');
      const initSampleTextX = sampleText ? sampleText.x : null;
      const initSampleLineX = sampleLine ? sampleLine.x : null;

      // Benchmark arrow key nudge across all 70-90+ elements
      const t1 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const nudgeElapsedMs = +(performance.now() - t1).toFixed(2);
      await sleep(100);

      const movedSampleTextX = sampleText ? sampleText.x : null;
      const movedSampleLineX = sampleLine ? sampleLine.x : null;
      const textDx = +(movedSampleTextX - initSampleTextX).toFixed(2);
      const lineDx = +(movedSampleLineX - initSampleLineX).toFixed(2);

      // Clean up test annotations
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      await sleep(200);
      const finalAnnsCount = window.annotationManager.annotations.length;

      return {
        selectedCount,
        textCount,
        lineCount,
        marqueeElapsedMs,
        nudgeElapsedMs,
        textDx,
        lineDx,
        finalAnnsCount
      };
    `);
    console.log('Test Case 14 Result:', tc14Result);

    if (tc14Result.selectedCount < 60) {
      throw new Error(`Test Case 14 failed: expected at least 60 items selected, got ${tc14Result.selectedCount}`);
    }
    if (tc14Result.marqueeElapsedMs > 600) {
      throw new Error(`Test Case 14 failed: marquee selection took ${tc14Result.marqueeElapsedMs}ms, exceeding 600ms threshold`);
    }
    if (tc14Result.nudgeElapsedMs > 50) {
      throw new Error(`Test Case 14 failed: arrow nudge took ${tc14Result.nudgeElapsedMs}ms, exceeding 50ms threshold`);
    }
    if (tc14Result.textDx !== 5 || tc14Result.lineDx !== 5) {
      throw new Error(`Test Case 14 failed: elements did not move by 5px, got textDx=${tc14Result.textDx}, lineDx=${tc14Result.lineDx}`);
    }
    if (tc14Result.finalAnnsCount !== 0) {
      throw new Error(`Test Case 14 failed: Delete key should remove all items, got ${tc14Result.finalAnnsCount}`);
    }
    console.log(`✅ Test Case 14 Passed: High-volume marquee selected ${tc14Result.selectedCount} items (${tc14Result.textCount} texts, ${tc14Result.lineCount} lines) in ${tc14Result.marqueeElapsedMs}ms (< 600ms) and nudged in ${tc14Result.nudgeElapsedMs}ms (< 50ms)!`);

    // --------------------------------------------------------------------------
    // Test Case 15 — Selected Text & Vector Line Annotations Rotate in Sync with Page (90° CW & 360° Identity)
    // --------------------------------------------------------------------------
    console.log('\n--- Test Case 15: Selected Text & Vector Line Annotations Rotate in Sync with Page ---');
    const tc15Result = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // 1. Reload fresh test_case1.pdf, clean annotations, switch to select tool
      const bin = atob("${pdfBase64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(350);
      document.querySelector('.tool-btn[data-tool="select"]').click();
      await sleep(200);
      window.annotationManager.annotations = [];
      window.annotationManager.deselectAll();
      await sleep(100);

      // 2. Marquee-select "Delivery Slip" and its vector underline (x: 10 to 200, y: 75 to 115)
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;

      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 10 * zoom, clientY: rect.top + 75 * zoom
      }));
      layer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      }));
      await window.uiController.canvasController.handlePointerUp({
        clientX: rect.left + 200 * zoom, clientY: rect.top + 115 * zoom
      });
      await sleep(150);

      const selAnns0 = window.annotationManager.getSelectedAnnotations();
      const textAnn0 = selAnns0.find(a => a.type === 'text');
      const lineAnn0 = selAnns0.find(a => a.type === 'line');
      if (!textAnn0 || !lineAnn0) {
        throw new Error('Test Case 15 setup failed: expected both text and line selected, got ' + JSON.stringify(selAnns0.map(a => a.type)));
      }

      const initText = { x: textAnn0.x, y: textAnn0.y, rot: textAnn0.rotation || 0 };
      const initLine = { x: lineAnn0.x, y: lineAnn0.y, w: lineAnn0.width, h: lineAnn0.height };
      const p1Size0 = window.pdfEngine.getPageSize(0);

      // 3. Click Page 1 Rotate button
      const rotateBtn = document.querySelector('.page-wrapper[data-page-index="0"] [data-action="rotate-page"]');
      rotateBtn.click();
      await sleep(350);

      const p1Size1 = window.pdfEngine.getPageSize(0);
      const getAnn = (id) => (window.annotationManager.getAnnotation ? window.annotationManager.getAnnotation(id) : window.annotationManager.getAnnotationById(id));
      const textAnn1 = getAnn(textAnn0.id);
      const lineAnn1 = getAnn(lineAnn0.id);
      const domTextEl1 = document.querySelector('.page-wrapper[data-page-index="0"] .pdf-text-element[data-id="' + textAnn0.id + '"]');

      const textAnn1Snapshot = { x: textAnn1.x, y: textAnn1.y, rot: textAnn1.rotation };
      const lineAnn1Snapshot = { x: lineAnn1.x, y: lineAnn1.y, w: lineAnn1.width, h: lineAnn1.height };
      const domTransform1 = domTextEl1 ? domTextEl1.style.transform : null;
      const domOrigin1 = domTextEl1 ? domTextEl1.style.transformOrigin : null;

      // 4. Rotate 3 more times (90° x 3 = 270°, total 360° = 0°)
      for (let r = 0; r < 3; r++) {
        rotateBtn.click();
        await sleep(300);
      }

      const p1Size4 = window.pdfEngine.getPageSize(0);
      const textAnn4 = getAnn(textAnn0.id);
      const lineAnn4 = getAnn(lineAnn0.id);
      const domTextEl4 = document.querySelector('.page-wrapper[data-page-index="0"] .pdf-text-element[data-id="' + textAnn0.id + '"]');

      return {
        initText,
        initLine,
        p1Size0,
        p1Size1,
        textAnn1: textAnn1Snapshot,
        lineAnn1: lineAnn1Snapshot,
        domTransform1,
        domOrigin1,
        p1Size4,
        textAnn4: { x: textAnn4.x, y: textAnn4.y, rot: textAnn4.rotation || 0 },
        lineAnn4: { x: lineAnn4.x, y: lineAnn4.y, w: lineAnn4.width, h: lineAnn4.height },
        domTransform4: domTextEl4 ? domTextEl4.style.transform : null
      };
    `);
    console.log('Test Case 15 Result:', tc15Result);

    // Assertions for 90° CW rotation
    if (tc15Result.p1Size1.width !== tc15Result.p1Size0.height || tc15Result.p1Size1.height !== tc15Result.p1Size0.width || tc15Result.p1Size1.userRotation !== 90) {
      throw new Error(`Test Case 15 failed: expected page size ${tc15Result.p1Size0.height}x${tc15Result.p1Size0.width} at 90°, got ${JSON.stringify(tc15Result.p1Size1)}`);
    }

    const expectedTextX1 = +(tc15Result.p1Size0.height - tc15Result.initText.y).toFixed(2);
    const expectedTextY1 = +(tc15Result.initText.x).toFixed(2);
    if (Math.abs(tc15Result.textAnn1.x - expectedTextX1) > 0.1 || Math.abs(tc15Result.textAnn1.y - expectedTextY1) > 0.1 || tc15Result.textAnn1.rot !== 90) {
      throw new Error(`Test Case 15 failed: text annotation not rotated accurately to (${tc15Result.p1Size0.height} - y, x): expected (${expectedTextX1}, ${expectedTextY1}) rot 90, got (${tc15Result.textAnn1.x}, ${tc15Result.textAnn1.y}) rot ${tc15Result.textAnn1.rot}`);
    }

    if (!tc15Result.domTransform1 || !tc15Result.domTransform1.includes('rotate(90deg)')) {
      throw new Error(`Test Case 15 failed: .pdf-text-element DOM style.transform should contain 'rotate(90deg)', got '${tc15Result.domTransform1}'`);
    }

    const expectedLineX1 = +(tc15Result.p1Size0.height - tc15Result.initLine.y).toFixed(2);
    const expectedLineY1 = +(tc15Result.initLine.x).toFixed(2);
    if (Math.abs(tc15Result.lineAnn1.x - expectedLineX1) > 0.1 || Math.abs(tc15Result.lineAnn1.y - expectedLineY1) > 0.1) {
      throw new Error(`Test Case 15 failed: line annotation not rotated accurately: expected (${expectedLineX1}, ${expectedLineY1}), got (${tc15Result.lineAnn1.x}, ${tc15Result.lineAnn1.y})`);
    }
    if (tc15Result.lineAnn1.w !== 0 || tc15Result.lineAnn1.h !== tc15Result.initLine.w) {
      throw new Error(`Test Case 15 failed: line horizontal width should become vertical height: expected w=0, h=${tc15Result.initLine.w}, got w=${tc15Result.lineAnn1.w}, h=${tc15Result.lineAnn1.h}`);
    }

    // Assertions for full 360° identity return
    if (tc15Result.p1Size4.width !== tc15Result.p1Size0.width || tc15Result.p1Size4.height !== tc15Result.p1Size0.height || tc15Result.p1Size4.userRotation !== 0) {
      throw new Error(`Test Case 15 failed: after 360° rotation page size should return to initial, got ${JSON.stringify(tc15Result.p1Size4)}`);
    }
    if (Math.abs(tc15Result.textAnn4.x - tc15Result.initText.x) > 0.1 || Math.abs(tc15Result.textAnn4.y - tc15Result.initText.y) > 0.1 || tc15Result.textAnn4.rot !== 0) {
      throw new Error(`Test Case 15 failed: after 360° rotation text annotation should return to exact initial coords, got (${tc15Result.textAnn4.x}, ${tc15Result.textAnn4.y}) rot ${tc15Result.textAnn4.rot}`);
    }
    if (Math.abs(tc15Result.lineAnn4.x - tc15Result.initLine.x) > 0.1 || Math.abs(tc15Result.lineAnn4.y - tc15Result.initLine.y) > 0.1 || tc15Result.lineAnn4.w !== tc15Result.initLine.w || tc15Result.lineAnn4.h !== tc15Result.initLine.h) {
      throw new Error(`Test Case 15 failed: after 360° rotation line annotation should return to exact initial coords and dimensions, got (${tc15Result.lineAnn4.x}, ${tc15Result.lineAnn4.y}) w=${tc15Result.lineAnn4.w}, h=${tc15Result.lineAnn4.h}`);
    }
    console.log(`✅ Test Case 15 Passed: Text & line annotations rotated in sync with page (90° CW transformed coords & DOM rotate(90deg), and 360° rotation returned to exact initial state)!`);

    console.log('\n🎉 ALL 15 BATCH GROUP EDITOR TESTS PASSED PERFECTLY! 🎉\n');
  } finally {
    chrome.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

runBatchGroupEditorTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
