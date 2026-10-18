const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testCenturionFix() {
  const PORT = 24000 + Math.floor(Math.random() * 5000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-centurion-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = targets.find(t => t.type === 'page');
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
    const base64 = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf').toString('base64');

    const evalRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const bin = atob("${base64}");
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

        // Helper to count dark ink pixels on the rendered PDF canvas within a PDF-coordinate box
        function countInkPixelsInRect(x, y, w, h) {
          const canvas = document.querySelector('.page-wrapper[data-page-index="0"] .pdf-canvas');
          const ctx = canvas.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const zoom = window.uiController.zoom || 1;
          const sx = Math.floor(x * zoom * dpr);
          const sy = Math.floor(y * zoom * dpr);
          const sw = Math.max(1, Math.floor(w * zoom * dpr));
          const sh = Math.max(1, Math.floor(h * zoom * dpr));
          const img = ctx.getImageData(sx, sy, sw, sh).data;
          let darkCount = 0;
          for (let i = 0; i < img.length; i += 4) {
            if (img[i] < 150 && img[i + 1] < 150 && img[i + 2] < 150 && img[i + 3] > 200) {
              darkCount++;
            }
          }
          return darkCount;
        }

        // Helper to simulate clicking at PDF coordinate (pdfX, pdfY) on page 0
        async function clickPdfPoint(pdfX, pdfY) {
          const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
          const rect = layer.getBoundingClientRect();
          const zoom = window.uiController.zoom || 1;
          const clientX = rect.left + pdfX * zoom;
          const clientY = rect.top + pdfY * zoom;
          await window.canvasController.handlePointerDown({
            button: 0,
            clientX,
            clientY,
            target: layer
          });
          await sleep(250);
        }

        // === TEST 1: Load test_case1.pdf, select text edit, click on "CENTURION" ===
        await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
        await sleep(300);
        document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
        await sleep(200);

        const itemsBefore1 = await window.pdfEngine.getTextItems(0);
        const centurionItem = itemsBefore1.find(it => it.str === 'CENTURION');
        const lumberItem = itemsBefore1.find(it => it.str === 'CENTURION LUMBER LTD');

        const lumberInkBefore = countInkPixelsInRect(lumberItem.x, lumberItem.y, lumberItem.width, lumberItem.height);

        // Click on "CENTURION"
        await clickPdfPoint(centurionItem.x + 15, centurionItem.y + 5);

        const itemsAfterClickCenturion = await window.pdfEngine.getTextItems(0);
        const lumberStillInStream = itemsAfterClickCenturion.some(it => it.str === 'CENTURION LUMBER LTD');
        const centurionRedactedFromStream = !itemsAfterClickCenturion.some(it => it.str === 'CENTURION');
        const lumberInkAfterClickCenturion = countInkPixelsInRect(lumberItem.x, lumberItem.y, lumberItem.width, lumberItem.height);
        const centurionInkAfterClickCenturion = countInkPixelsInRect(centurionItem.x, centurionItem.y, centurionItem.width, centurionItem.height);
        const spawnedText1 = window.annotationManager.annotations.map(a => a.text);

        // === TEST 2: Reload test_case1.pdf, select text edit, click on line below CENTURION ("CENTURION LUMBER LTD") ===
        await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
        await sleep(300);
        document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
        await sleep(200);

        const centurionInkBefore = countInkPixelsInRect(centurionItem.x, centurionItem.y, centurionItem.width, centurionItem.height);

        // Click on "CENTURION LUMBER LTD" (line below CENTURION)
        await clickPdfPoint(lumberItem.x + 25, lumberItem.y + 5);

        const itemsAfterClickLumber = await window.pdfEngine.getTextItems(0);
        const centurionStillInStream = itemsAfterClickLumber.some(it => it.str === 'CENTURION');
        const lumberRedactedFromStream = !itemsAfterClickLumber.some(it => it.str === 'CENTURION LUMBER LTD');
        const centurionInkAfterClickLumber = countInkPixelsInRect(centurionItem.x, centurionItem.y, centurionItem.width, centurionItem.height);
        const lumberInkAfterClickLumber = countInkPixelsInRect(lumberItem.x, lumberItem.y, lumberItem.width, lumberItem.height);
        const spawnedText2 = window.annotationManager.annotations.map(a => a.text);

        // === TEST 3: Now ALSO click on "CENTURION" so both lines are edited ===
        await clickPdfPoint(centurionItem.x + 15, centurionItem.y + 5);
        const spawnedTextBoth = window.annotationManager.annotations.map(a => a.text);

        // === TEST 4: Duplicate text on different lines ("CAN1033042" at Cust Ord No vs Booking Number) ===
        const canItemsBefore = (await window.pdfEngine.getTextItems(0)).filter(it => it.str === 'CAN1033042');
        await clickPdfPoint(canItemsBefore[0].x + 15, canItemsBefore[0].y + 5);
        const canItemsAfter = (await window.pdfEngine.getTextItems(0)).filter(it => it.str === 'CAN1033042');

        return {
          test1_ClickCenturion: {
            centurionRedactedFromStream,
            lumberStillInStream,
            lumberInkBefore,
            lumberInkAfterClickCenturion,
            centurionInkAfterClickCenturion,
            spawnedText1
          },
          test2_ClickBelowCenturion: {
            lumberRedactedFromStream,
            centurionStillInStream,
            centurionInkBefore,
            centurionInkAfterClickLumber,
            lumberInkAfterClickLumber,
            spawnedText2
          },
          test3_BothEdited: {
            spawnedTextBoth
          },
          test4_DuplicateStringsOnDifferentLines: {
            canCountBefore: canItemsBefore.length,
            canCountAfterClickingFirst: canItemsAfter.length
          }
        };
      })()`
    });

    if (evalRes.exceptionDetails) {
      throw new Error(JSON.stringify(evalRes.exceptionDetails));
    }

    const res = evalRes.result.value;
    console.log('Centurion Fix Test Results:', JSON.stringify(res, null, 2));

    // Assertions for Test 1 (Click CENTURION -> next line CENTURION LUMBER LTD must NOT disappear)
    if (!res.test1_ClickCenturion.centurionRedactedFromStream) {
      throw new Error('CENTURION was not redacted when clicked');
    }
    if (!res.test1_ClickCenturion.lumberStillInStream) {
      throw new Error('CENTURION LUMBER LTD disappeared from stream when clicking CENTURION!');
    }
    if (res.test1_ClickCenturion.lumberInkAfterClickCenturion !== res.test1_ClickCenturion.lumberInkBefore ||
        res.test1_ClickCenturion.lumberInkAfterClickCenturion === 0) {
      throw new Error('CENTURION LUMBER LTD canvas pixels changed/disappeared when clicking CENTURION!');
    }
    if (res.test1_ClickCenturion.centurionInkAfterClickCenturion !== 0) {
      throw new Error('CENTURION canvas ink was not cleared');
    }

    // Assertions for Test 2 (Reload, click line below CENTURION -> CENTURION must NOT disappear)
    if (!res.test2_ClickBelowCenturion.lumberRedactedFromStream) {
      throw new Error('CENTURION LUMBER LTD was not redacted when clicked');
    }
    if (!res.test2_ClickBelowCenturion.centurionStillInStream) {
      throw new Error('CENTURION disappeared from stream when clicking CENTURION LUMBER LTD!');
    }
    if (res.test2_ClickBelowCenturion.centurionInkAfterClickLumber !== res.test2_ClickBelowCenturion.centurionInkBefore ||
        res.test2_ClickBelowCenturion.centurionInkAfterClickLumber === 0) {
      throw new Error('CENTURION canvas pixels changed/disappeared when clicking CENTURION LUMBER LTD!');
    }
    if (res.test2_ClickBelowCenturion.lumberInkAfterClickLumber !== 0) {
      throw new Error('CENTURION LUMBER LTD canvas ink was not cleared');
    }

    // Assertions for Test 3 & Test 4
    if (JSON.stringify(res.test3_BothEdited.spawnedTextBoth) !== JSON.stringify(['CENTURION LUMBER LTD', 'CENTURION'])) {
      throw new Error('Expected both lines to be editable text annotations, got: ' + JSON.stringify(res.test3_BothEdited));
    }
    if (res.test4_DuplicateStringsOnDifferentLines.canCountBefore !== 2 ||
        res.test4_DuplicateStringsOnDifferentLines.canCountAfterClickingFirst !== 1) {
      throw new Error('Expected only the clicked CAN1033042 line to be redacted, got: ' + JSON.stringify(res.test4_DuplicateStringsOnDifferentLines));
    }

    console.log('✅ ALL CENTURION & ADJACENT LINE REDACTION TESTS PASSED!');
    ws.close();
  } finally {
    chrome.kill();
  }
}

testCenturionFix().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
