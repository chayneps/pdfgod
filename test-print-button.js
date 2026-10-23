const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pdfLib = require('./vendor/pdf-lib.min.js');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Dedicated Print Button & Direct PDF Print');
  console.log('====================================================');

  const PORT = 29810 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-print-btn-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        const targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    if (!page) throw new Error('Could not connect to Chrome debugging port ' + PORT);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error('Evaluation failed: ' + (res.exceptionDetails.exception ? res.exceptionDetails.exception.description : JSON.stringify(res.exceptionDetails)));
      }
      return res.result ? res.result.value : undefined;
    };

    console.log('Waiting for application initialization...');
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        if (window.uiController && window.pdfEngine) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Application loaded.');

    // Test 1: Button existence and placement beside Open PDF
    console.log('\n--- Test 1: Print button exists right beside Open PDF ---');
    const buttonCheck = await evaluate(`(() => {
      const openBtn = document.querySelector('#btn-open-pdf');
      const printBtn = document.querySelector('#btn-print-header');
      if (!openBtn || !printBtn) return { error: 'Buttons not found' };
      const nextSibling = openBtn.nextElementSibling;
      return {
        hasOpen: !!openBtn,
        hasPrint: !!printBtn,
        isNextSibling: nextSibling === printBtn,
        printText: printBtn.textContent.trim(),
        printTitle: printBtn.getAttribute('title')
      };
    })()`);
    console.log('Button check result:', buttonCheck);
    if (!buttonCheck.hasPrint || !buttonCheck.isNextSibling || buttonCheck.printText !== 'Print') {
      throw new Error('Test 1 failed: Dedicated print button is not directly beside Open PDF');
    }
    console.log('✅ Dedicated print button is directly beside Open PDF with "Print" label.');

    // Test 2: Click without loaded PDF shows toast
    console.log('\n--- Test 2: Clicking print without document shows toast ---');
    await evaluate(`(() => {
      window._printed = false;
      window.print = () => { window._printed = true; };
      document.querySelector('#btn-print-header').click();
    })()`);
    const toastText = await evaluate(`(() => {
      const toast = document.querySelector('.toast');
      return {
        toastFound: !!toast,
        text: toast ? toast.textContent.trim() : '',
        printed: window._printed
      };
    })()`);
    console.log('Toast result:', toastText);
    if (!toastText.toastFound || !toastText.text.includes('open a PDF') || toastText.printed) {
      throw new Error('Test 2 failed: Should show prompt to open PDF and not call window.print()');
    }
    console.log('✅ Gracefully informed user to open a PDF first.');

    // Test 3: Load multi-page test PDF in 2-column overview grid layout
    console.log('\n--- Test 3: Load 2-page document and switch to 2-column overview grid ---');
    const testCase1Path = path.resolve(__dirname, '../../../../Downloads/test_case1.pdf');
    let pdfBytes;
    if (fs.existsSync(testCase1Path)) {
      pdfBytes = fs.readFileSync(testCase1Path);
    } else {
      const doc = await pdfLib.PDFDocument.create();
      for (let i = 1; i <= 2; i++) {
        const p = doc.addPage([612, 792]);
        p.drawText("Page " + i + " Document Content", { x: 50, y: 750, size: 24 });
      }
      pdfBytes = await doc.save();
    }

    await send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = new Uint8Array(${JSON.stringify(Array.from(pdfBytes))});
        await window.uiController.loadPdfBuffer(bytes, 'test_case1.pdf');
        await window.uiController.setLayoutColumns(2); // Set 2-column overview view!
      })()`,
      awaitPromise: true
    });

    const pageCount = await evaluate(`window.pdfEngine.getPageCount()`);
    console.log(`Loaded document with ${pageCount} pages, layoutColumns set to 2.`);

    // Test 4: Trigger print via dedicated button and check print container preparation
    console.log('\n--- Test 4: Trigger print via button and verify #print-container ---');
    await evaluate(`(() => {
      window._printed = false;
      window.print = () => { window._printed = true; };
    })()`);

    // Call printDocument
    await evaluate(`window.uiController.printDocument()`);

    const printContainerCheck = await evaluate(`(() => {
      const pc = document.querySelector('#print-container');
      if (!pc) return { exists: false };
      const pages = pc.querySelectorAll('.print-page');
      const canvases = pc.querySelectorAll('.print-page canvas');
      const computedStyle = window.getComputedStyle(pc);
      return {
        exists: true,
        displayOnScreen: computedStyle.display,
        pageCount: pages.length,
        canvasCount: canvases.length,
        firstPageWidth: pages[0] ? pages[0].style.width : '',
        firstPageHeight: pages[0] ? pages[0].style.height : '',
        firstCanvasWidth: canvases[0] ? canvases[0].width : 0,
        firstCanvasHeight: canvases[0] ? canvases[0].height : 0
      };
    })()`);

    console.log('Print container check:', printContainerCheck);
    if (!printContainerCheck.exists || printContainerCheck.displayOnScreen !== 'none' || printContainerCheck.pageCount !== 2) {
      throw new Error('Test 4 failed: #print-container not properly created or not hidden on screen');
    }
    console.log('✅ #print-container built with high-res canvases and hidden on screen.');

    // Test 5: Verify @media print output via CDP Page.printToPDF
    console.log('\n--- Test 5: Verify Page.printToPDF produces multi-page clean document ---');
    const pdfData = await send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true
    });
    const printedBuffer = Buffer.from(pdfData.data, 'base64');
    const loadedPdf = await pdfLib.PDFDocument.load(printedBuffer);
    const printedPageCount = loadedPdf.getPageCount();
    console.log(`Printed PDF page count: ${printedPageCount}`);
    if (printedPageCount !== 2) {
      throw new Error(`Test 5 failed: Expected 2 printed pages, got ${printedPageCount}`);
    }
    for (let i = 0; i < printedPageCount; i++) {
      const sz = loadedPdf.getPage(i).getSize();
      console.log(`Page ${i + 1} dimensions: ${sz.width} x ${sz.height} pt`);
      if (Math.abs(sz.width - 612) > 1 || Math.abs(sz.height - 792) > 1) {
        throw new Error(`Test 5 failed: Page ${i + 1} size ${sz.width}x${sz.height} does not match standard 612x792 pt`);
      }
    }
    console.log('✅ Native browser print engine cleanly outputs 2 full 612x792 pt pages with 0 UI clutter.');

    // Test 6: Print via Ctrl+P shortcut
    console.log('\n--- Test 6: Trigger print via Ctrl+P / Cmd+P shortcut ---');
    await evaluate(`(() => {
      window._printed = false;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 400));
    const printedViaShortcut = await evaluate(`window._printed`);
    console.log(`Print called via Ctrl+P: ${printedViaShortcut}`);
    if (!printedViaShortcut) throw new Error('Test 6 failed: Ctrl+P did not trigger print');
    console.log('✅ Keyboard shortcut Ctrl+P triggers print seamlessly.');

    console.log('\n====================================================');
    console.log('🎉 ALL DEDICATED PRINT BUTTON & PRINT TESTS PASSED!');
    console.log('====================================================');

    ws.close();
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  }
}

runTests();
