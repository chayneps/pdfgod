const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('./vendor/pdf-lib.min.js');

async function testRearrange() {
  console.log('--- Starting Add to Bottom & Rearrange Test Suite ---');
  const PORT = 23000 + Math.floor(Math.random() * 6000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch('http://127.0.0.1:' + PORT + '/json');
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    console.log('1. Loading initial 2-page document test_case1.pdf...');
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');

    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
      // Set current page explicitly to Page 1 (index 0)
      window.uiController.switchActivePage(0);
    `);

    console.log('2. Adding new PDF pages while on Page 1 (verifying it appends to the BOTTOM)...');
    const addResult = await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      // Trigger addPagesFromPdfBuffer with default / null index
      const res = await window.uiController.addPagesFromPdfBuffer(u8.buffer);
      const pageOrder = window.pdfEngine.pageOrder.map(p => p.srcIndex);
      return {
        res,
        pageOrder,
        pageCount: window.pdfEngine.getPageCount(),
        activePage: window.uiController.currentPage
      };
    `);

    console.log('Add Result:', addResult);
    // Initial was src 0, 1. Appended should be src 2, 3 at the bottom!
    // Resulting pageOrder should be [0, 1, 2, 3]
    if (JSON.stringify(addResult.pageOrder) !== JSON.stringify([0, 1, 2, 3])) {
      throw new Error(`Pages were not added at the bottom! Got pageOrder: ${JSON.stringify(addResult.pageOrder)}`);
    }
    console.log('✅ Pages successfully added at the BOTTOM: pageOrder = [0, 1, 2, 3]');

    console.log('3. Verifying Move Up / Move Down buttons on thumbnails...');
    const btnChecks = await evaluate(`
      const cards = document.querySelectorAll('.thumbnail-card');
      const firstCardUpBtn = cards[0].querySelector('[data-action="move-up"]');
      const lastCardDownBtn = cards[cards.length - 1].querySelector('[data-action="move-down"]');
      const midCardUpBtn = cards[1].querySelector('[data-action="move-up"]');
      const midCardDownBtn = cards[1].querySelector('[data-action="move-down"]');
      return {
        firstCardUpDisabled: firstCardUpBtn.hasAttribute('disabled'),
        lastCardDownDisabled: lastCardDownBtn.hasAttribute('disabled'),
        midCardUpDisabled: midCardUpBtn.hasAttribute('disabled'),
        midCardDownDisabled: midCardDownBtn.hasAttribute('disabled')
      };
    `);

    console.log('Button state checks:', btnChecks);
    if (!btnChecks.firstCardUpDisabled) throw new Error('First card Move Up button should be disabled!');
    if (!btnChecks.lastCardDownDisabled) throw new Error('Last card Move Down button should be disabled!');
    if (btnChecks.midCardUpDisabled || btnChecks.midCardDownDisabled) throw new Error('Middle card buttons should be enabled!');
    console.log('✅ Button disabled states verified.');

    console.log('4. Testing Rearrange via Move Down button on Page 1 (moves to pos 2)...');
    await evaluate(`
      const cards = document.querySelectorAll('.thumbnail-card');
      const downBtn = cards[0].querySelector('[data-action="move-down"]');
      downBtn.click();
    `);
    // Wait for render
    await new Promise(r => setTimeout(r, 600));

    const afterMoveDown = await evaluate(`
      return {
        pageOrder: window.pdfEngine.pageOrder.map(p => p.srcIndex),
        activePage: window.uiController.currentPage
      };
    `);
    console.log('After Move Down:', afterMoveDown);
    // Page 0 moved to index 1 -> [1, 0, 2, 3]
    if (JSON.stringify(afterMoveDown.pageOrder) !== JSON.stringify([1, 0, 2, 3])) {
      throw new Error(`Unexpected pageOrder after move down: ${JSON.stringify(afterMoveDown.pageOrder)}`);
    }
    console.log('✅ Move Down button successfully moved page from index 0 to 1.');

    console.log('5. Testing Rearrange via Move Up button (moves back to pos 1)...');
    await evaluate(`
      const cards = document.querySelectorAll('.thumbnail-card');
      const upBtn = cards[1].querySelector('[data-action="move-up"]');
      upBtn.click();
    `);
    await new Promise(r => setTimeout(r, 600));

    const afterMoveUp = await evaluate(`
      return {
        pageOrder: window.pdfEngine.pageOrder.map(p => p.srcIndex),
        activePage: window.uiController.currentPage
      };
    `);
    console.log('After Move Up:', afterMoveUp);
    if (JSON.stringify(afterMoveUp.pageOrder) !== JSON.stringify([0, 1, 2, 3])) {
      throw new Error(`Unexpected pageOrder after move up: ${JSON.stringify(afterMoveUp.pageOrder)}`);
    }
    console.log('✅ Move Up button successfully moved page back to index 0.');

    console.log('6. Testing Annotation Tracking during page rearrange...');
    await evaluate(`
      window.uiController.annotationManager.addAnnotation({
        pageIndex: 1, // on page index 1 (srcIndex 1)
        type: 'text',
        text: 'TEST ANNOTATION ON PAGE 2',
        x: 50,
        y: 50,
        width: 200,
        height: 20
      });
      // Move page 1 to the end (index 3)
      await window.uiController.reorderPage(1, 3);
    `);
    await new Promise(r => setTimeout(r, 600));

    const annotationTracking = await evaluate(`
      const ann = window.uiController.annotationManager.annotations[0];
      return {
        annPageIndex: ann.pageIndex,
        pageOrder: window.pdfEngine.pageOrder.map(p => p.srcIndex)
      };
    `);
    console.log('Annotation Tracking result:', annotationTracking);
    // After moving index 1 to 3, pageOrder is [0, 2, 3, 1].
    // The page that was at index 1 is now at index 3, so ann.pageIndex must be 3!
    if (annotationTracking.annPageIndex !== 3) {
      throw new Error(`Annotation did not track page movement! Expected pageIndex 3, got ${annotationTracking.annPageIndex}`);
    }
    console.log('✅ Annotation page index perfectly tracked through page rearrangement.');

    console.log('7. Testing Drag and Drop attributes on thumbnail cards...');
    const dndCheck = await evaluate(`
      const cards = document.querySelectorAll('.thumbnail-card');
      return Array.from(cards).every(c => c.getAttribute('draggable') === 'true');
    `);
    if (!dndCheck) throw new Error('Thumbnail cards do not have draggable="true"!');
    console.log('✅ Draggable attribute confirmed on all thumbnail cards.');

    console.log('8. Capturing visual screenshot...');
    await send('Page.enable');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve(__dirname, 'test-rearrange-success.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot saved to test-rearrange-success.png');

    console.log('\n🎉 ALL REARRANGE & ADD-TO-BOTTOM TESTS PASSED 100%!');
  } finally {
    chrome.kill('SIGKILL');
  }
}

testRearrange().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
