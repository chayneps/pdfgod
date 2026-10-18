const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8153;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

async function runTests() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Server listening on http://localhost:${PORT}`);

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const debugPort = 9363;
  const userDataDir = `/tmp/chrome-test-arrange-${Date.now()}`;

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1440,900',
    `http://localhost:${PORT}/pdfgod.html`
  ]);

  await new Promise(r => setTimeout(r, 2500));

  try {
    const targetsRes = await fetch(`http://localhost:${debugPort}/json`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = msgId++;
      const listener = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          ws.removeEventListener('message', listener);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');

    const evalRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

        // 1. Helper to create labeled PDF
        async function createLabeledPdfFile(filename, pageLabels) {
          const doc = await PDFDocument.create();
          const font = await doc.embedFont(StandardFonts.HelveticaBold);
          for (const label of pageLabels) {
            const page = doc.addPage([500, 400]);
            page.drawRectangle({ x: 0, y: 0, width: 500, height: 400, color: rgb(0.9, 0.9, 0.95) });
            page.drawText(label, { x: 50, y: 200, size: 28, font, color: rgb(0.1, 0.1, 0.1) });
          }
          const bytes = await doc.save();
          return new File([bytes], filename, { type: 'application/pdf' });
        }

        async function getDocumentLabels() {
          const count = window.pdfEngine.getPageCount();
          const labels = [];
          for (let p = 0; p < count; p++) {
            const items = await window.pdfEngine.getTextItems(p);
            labels.push(items.length > 0 ? items[0].str : '(blank)');
          }
          return labels;
        }

        // Wait for uiController
        while (!window.uiController) await sleep(50);

        // Load 2-page base document
        const basePdf = await createLabeledPdfFile('base.pdf', ['DOC_PAGE_A', 'DOC_PAGE_B']);
        const baseBuf = await basePdf.arrayBuffer();
        await window.uiController.loadPdfBuffer(baseBuf, 'base.pdf');
        await sleep(300);

        const initialLabels = await getDocumentLabels();

        // 2. Check Page Header Bars on both pages
        const wrappers = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
        const headers = Array.from(document.querySelectorAll('.page-header-bar'));
        const badges = Array.from(document.querySelectorAll('.page-number-badge')).map(b => b.textContent.trim());

        const hasHeaders = headers.length === 2 && wrappers.length === 2;
        const initialBadges = badges;

        // 3. Switch to 2-page spread view
        await window.uiController.setLayoutColumns(2, true);
        await sleep(300);

        // 4. Test quick arrange buttons: click Move Left on Page 2 (pos 1)
        const p1MoveLeftBtn = wrappers[1].querySelector('.page-header-bar [data-action="move-left"]');
        if (p1MoveLeftBtn) {
          p1MoveLeftBtn.click();
        }
        await sleep(300);
        const labelsAfterMoveLeft = await getDocumentLabels();

        // Now DOC_PAGE_B is at index 0, DOC_PAGE_A is at index 1.
        // Test quick arrange: click Move Right on Page 1 (pos 0) to swap back
        const p0MoveRightBtn = document.querySelectorAll('.document-container .page-wrapper')[0].querySelector('.page-header-bar [data-action="move-right"]');
        if (p0MoveRightBtn) {
          p0MoveRightBtn.click();
        }
        await sleep(300);
        const labelsAfterMoveRight = await getDocumentLabels();

        // 5. Test Drag-and-Drop Page Arrangement in 2-page view
        // Drag Page 2 (fromIndex = 1) and drop before Page 1 (to the left of Page 1)
        const curWrappers = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
        const p0Rect = curWrappers[0].getBoundingClientRect();
        const p1Rect = curWrappers[1].getBoundingClientRect();

        // Target: left side of Page 1 (x = p0Rect.left + 50, y = p0Rect.top + 100)
        const dtPageDrag = new DataTransfer();
        dtPageDrag.setData('text/plain', '1');
        dtPageDrag.setData('application/x-pdfgod-page-index', '1');

        window.uiController.isInternalPageDrag = true;
        window.uiController.draggedPageIndex = 1;

        window.uiController.viewport.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: p0Rect.left + 50,
          clientY: p0Rect.top + 100,
          dataTransfer: dtPageDrag
        }));

        const p0HasDropLeft = curWrappers[0].classList.contains('page-drop-left');

        window.uiController.viewport.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: p0Rect.left + 50,
          clientY: p0Rect.top + 100,
          dataTransfer: dtPageDrag
        }));
        await sleep(400);
        const labelsAfterDragArrange = await getDocumentLabels();

        // 6. Test Dragging PDF files onto main page view to insert pages
        // Create an external PDF file to insert
        const insertPdf = await createLabeledPdfFile('inserted.pdf', ['INSERTED_PAGE_1', 'INSERTED_PAGE_2']);

        // Hover in between the two pages in 2-page view
        const curW2 = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
        const r0 = curW2[0].getBoundingClientRect();
        const r1 = curW2[1].getBoundingClientRect();
        const gapX = (r0.right + r1.left) / 2;
        const midY = (r0.top + r0.bottom) / 2;

        const dtFileBetween = new DataTransfer();
        dtFileBetween.items.add(insertPdf);

        window.uiController.viewport.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: gapX,
          clientY: midY,
          dataTransfer: dtFileBetween
        }));

        const indicatorShown = curW2[0].classList.contains('page-drop-right') || curW2[1].classList.contains('page-drop-left');
        const hintEl = document.getElementById('viewport-drop-hint');
        const hintVisible = hintEl && hintEl.classList.contains('visible');
        const hintText = hintEl ? hintEl.querySelector('.drop-hint-text').textContent : '';

        window.uiController.viewport.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: gapX,
          clientY: midY,
          dataTransfer: dtFileBetween
        }));
        await sleep(600);
        const labelsAfterFileDrop = await getDocumentLabels();

        // 7. Test dropping non-PDF files does nothing
        const fakeTxtFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        const dtTxt = new DataTransfer();
        dtTxt.items.add(fakeTxtFile);

        window.uiController.viewport.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: gapX,
          clientY: midY,
          dataTransfer: dtTxt
        }));
        await sleep(200);
        const labelsAfterTxtDrop = await getDocumentLabels();

        // 8. Test 3-page view arrange
        await window.uiController.setLayoutColumns(3, true);
        await sleep(300);
        const wrappers3 = Array.from(document.querySelectorAll('.document-container .page-wrapper'));
        const headers3 = Array.from(document.querySelectorAll('.page-header-bar'));

        return {
          initialLabels,
          hasHeaders,
          initialBadges,
          labelsAfterMoveLeft,
          labelsAfterMoveRight,
          p0HasDropLeft,
          labelsAfterDragArrange,
          indicatorShown,
          hintVisible,
          hintText,
          labelsAfterFileDrop,
          labelsAfterTxtDrop,
          pageCountIn3Cols: wrappers3.length,
          headerCountIn3Cols: headers3.length
        };
      })()`
    });

    const res = evalRes.result.value;
    console.log('Test Results:', JSON.stringify(res, null, 2));

    if (!res) {
      throw new Error('Test returned null/undefined: ' + JSON.stringify(evalRes));
    }

    // 1. Initial document check
    if (JSON.stringify(res.initialLabels) !== JSON.stringify(['DOC_PAGE_A', 'DOC_PAGE_B'])) {
      throw new Error('Unexpected initialLabels: ' + JSON.stringify(res.initialLabels));
    }
    if (!res.hasHeaders || res.initialBadges.length !== 2) {
      throw new Error('Page headers or badges not created properly: ' + JSON.stringify(res.initialBadges));
    }
    console.log('✅ Page header bars and badges created successfully on each page wrapper.');

    // 2. Quick arrange buttons in 2-page view
    if (JSON.stringify(res.labelsAfterMoveLeft) !== JSON.stringify(['DOC_PAGE_B', 'DOC_PAGE_A'])) {
      throw new Error('Move Left did not reorder pages: ' + JSON.stringify(res.labelsAfterMoveLeft));
    }
    console.log('✅ Move Left button in 2-page view successfully swapped pages.');

    if (JSON.stringify(res.labelsAfterMoveRight) !== JSON.stringify(['DOC_PAGE_A', 'DOC_PAGE_B'])) {
      throw new Error('Move Right did not reorder pages back: ' + JSON.stringify(res.labelsAfterMoveRight));
    }
    console.log('✅ Move Right button in 2-page view successfully restored page order.');

    // 3. Drag and Drop page arrangement
    if (!res.p0HasDropLeft) {
      throw new Error('page-drop-left indicator was not shown during page arrange drag');
    }
    if (JSON.stringify(res.labelsAfterDragArrange) !== JSON.stringify(['DOC_PAGE_B', 'DOC_PAGE_A'])) {
      throw new Error('Drag and drop page arrange failed: ' + JSON.stringify(res.labelsAfterDragArrange));
    }
    console.log('✅ Drag-and-drop page arrange in 2-page view successfully reordered pages.');

    // 4. Drag external PDF into main page view between pages
    if (!res.indicatorShown) {
      throw new Error('Drop indicator between pages in main page view was not shown on dragover');
    }
    if (!res.hintVisible || !res.hintText.includes('Drop PDF')) {
      throw new Error('Floating drop hint not shown properly: ' + res.hintText);
    }
    if (JSON.stringify(res.labelsAfterFileDrop) !== JSON.stringify(['DOC_PAGE_B', 'INSERTED_PAGE_1', 'INSERTED_PAGE_2', 'DOC_PAGE_A'])) {
      throw new Error('Dropped PDF was not inserted at the target slot in main page view: ' + JSON.stringify(res.labelsAfterFileDrop));
    }
    console.log('✅ Dragging external PDF into main page view inserted pages at the target position.');

    // 5. Non-PDF files drop test
    if (JSON.stringify(res.labelsAfterTxtDrop) !== JSON.stringify(res.labelsAfterFileDrop)) {
      throw new Error('Non-PDF drop should do nothing, but page order/count changed');
    }
    console.log('✅ Dropping non-PDF files does nothing.');

    // 6. 3-column view check
    if (res.pageCountIn3Cols !== 4 || res.headerCountIn3Cols !== 4) {
      throw new Error(`Expected 4 pages and 4 headers in 3-column view, got ${res.pageCountIn3Cols} / ${res.headerCountIn3Cols}`);
    }
    console.log('✅ 3-column view renders headers and arrange handles on all pages.');

    // Capture screenshot of the multi-column view with header bars
    const screenshotData = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'test-arrange-2cols.png'), Buffer.from(screenshotData.data, 'base64'));
    console.log('   Saved screenshot to test-arrange-2cols.png');

    console.log('\n🎉 ALL PAGE ARRANGE AND MAIN VIEW PDF DROP TESTS PASSED! 🎉\n');

  } finally {
    chrome.kill();
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
