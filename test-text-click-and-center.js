const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testTextClickAndCenter() {
  console.log('--- Starting Two-Stage Text Click & Center Text on Page Test Suite ---');
  const PORT = 24000 + Math.floor(Math.random() * 5000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-click-center-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
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
    await send('Page.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    const base64 = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf').toString('base64');

    console.log('1. Loading test_case1.pdf and switching to Edit PDF Text mode...');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      while (!window.uiController || !window.pdfEngine) await sleep(50);
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
      await sleep(300);
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);
    `);

    console.log('2. Testing 1st Click on PDF text ("Delivery Slip"): should select text box ONLY (not focus textarea)...');
    const firstClickState = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const items = await window.pdfEngine.getTextItems(0);
      const targetItem = items.find(it => it.str === 'Delivery Slip') || items.find(it => it.str === 'CENTURION');
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const rect = layer.getBoundingClientRect();
      const zoom = window.uiController.zoom || 1;
      const clickX = rect.left + (targetItem.x + 15) * zoom;
      const clickY = rect.top + (targetItem.y + 5) * zoom;

      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY
      }));
      await sleep(100);

      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('.pdf-text-element[data-id="' + ann.id + '"]');
      const ta = el.querySelector('.pdf-text-content');
      return {
        id: ann.id,
        text: ann.text,
        x: ann.x,
        y: ann.y,
        boxWidth: ann.width,
        isBoxSelected: el.classList.contains('selected'),
        isTextareaFocused: document.activeElement === ta
      };
    `);
    console.log('   1st Click State:', firstClickState);
    if (!firstClickState.isBoxSelected) {
      throw new Error('Expected text box to be selected on 1st click!');
    }
    if (firstClickState.isTextareaFocused) {
      throw new Error('Expected textarea NOT to be focused on 1st click!');
    }
    console.log('   ✅ 1st click selected the text box without focusing textarea!');

    console.log('3. Testing Left/Right arrow keys after 1st click: should move the whole text box...');
    const afterArrowsFirstClick = await evaluate(`
      const ann = window.annotationManager.getSelectedAnnotation();
      const startX = ann.x;

      // Press ArrowRight (+5px)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const afterRight = ann.x;

      // Press Shift+ArrowRight (+1px)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
      const afterShiftRight = ann.x;

      // Press ArrowLeft (-5px)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      const afterLeft = ann.x;

      return { startX, afterRight, afterShiftRight, afterLeft };
    `);
    console.log('   Arrow key positions on 1st click:', afterArrowsFirstClick);
    if (afterArrowsFirstClick.afterRight !== afterArrowsFirstClick.startX + 5 ||
        afterArrowsFirstClick.afterShiftRight !== afterArrowsFirstClick.startX + 6 ||
        afterArrowsFirstClick.afterLeft !== afterArrowsFirstClick.startX + 1) {
      throw new Error('ArrowLeft / ArrowRight did not move the text box as expected: ' + JSON.stringify(afterArrowsFirstClick));
    }
    console.log('   ✅ Left/Right arrow keys move the whole text box after 1st click!');

    console.log('4. Testing 2nd Click on the already-selected text box: should focus textarea for character editing...');
    const secondClickState = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const ann = window.annotationManager.getSelectedAnnotation();
      const el = document.querySelector('.pdf-text-element[data-id="' + ann.id + '"]');
      const ta = el.querySelector('.pdf-text-content');
      const rect = ta.getBoundingClientRect();
      const clickX = rect.left + 15;
      const clickY = rect.top + 5;

      ta.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY
      }));
      await sleep(50);

      const isFocusedAfterSecondClick = document.activeElement === ta;
      const boxXBeforeArrow = ann.x;

      // Set cursor at index 3 and press ArrowLeft on textarea: should NOT move boxX!
      ta.setSelectionRange(3, 3);
      const keyEvt = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
      ta.dispatchEvent(keyEvt);

      return {
        isFocusedAfterSecondClick,
        boxXBeforeArrow,
        boxXAfterArrow: ann.x,
        defaultPreventedOnArrowLeft: keyEvt.defaultPrevented
      };
    `);
    console.log('   2nd Click State:', secondClickState);
    if (!secondClickState.isFocusedAfterSecondClick) {
      throw new Error('Expected textarea to be focused after 2nd click!');
    }
    if (secondClickState.boxXAfterArrow !== secondClickState.boxXBeforeArrow || secondClickState.defaultPreventedOnArrowLeft) {
      throw new Error('Expected ArrowLeft inside focused textarea on 2nd click to move character cursor, NOT move the box!');
    }
    console.log('   ✅ 2nd click entered character-editing mode where Left/Right arrows navigate characters instead of moving the box!');

    console.log('5. Testing clicking outside to unselect, then 1st-clicking the existing text box again...');
    const reclickExistingState = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const annId = window.annotationManager.getSelectedAnnotation().id;
      const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
      const lRect = layer.getBoundingClientRect();

      // Click outside on empty space to unselect
      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: lRect.left + 10, clientY: lRect.top + 10
      }));
      await sleep(50);
      const selectedAfterOutside = window.annotationManager.getSelectedAnnotations().length;

      // Now 1st click on the existing .pdf-text-element
      const el = document.querySelector('.pdf-text-element[data-id="' + annId + '"]');
      const ta = el.querySelector('.pdf-text-content');
      const r = ta.getBoundingClientRect();
      const notPrevented1 = ta.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: r.left + 10, clientY: r.top + 5
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0, clientX: r.left + 10, clientY: r.top + 5
      }));
      await sleep(50);

      const ann = window.annotationManager.getAnnotation(annId);
      const xBefore = ann.x;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      const xAfterLeft = ann.x;

      return {
        selectedAfterOutside,
        pointerdownPreventedOn1stClick: !notPrevented1,
        isBoxSelectedOn1stClick: window.annotationManager.isSelected(annId),
        isTextareaFocusedOn1stClick: document.activeElement === ta,
        xBefore,
        xAfterLeft
      };
    `);
    console.log('   Re-click existing text box state:', reclickExistingState);
    if (reclickExistingState.selectedAfterOutside !== 0 ||
        !reclickExistingState.pointerdownPreventedOn1stClick ||
        !reclickExistingState.isBoxSelectedOn1stClick ||
        reclickExistingState.isTextareaFocusedOn1stClick ||
        reclickExistingState.xAfterLeft !== reclickExistingState.xBefore - 5) {
      throw new Error('Re-clicking unselected existing text box did not behave as 1st-click box selection: ' + JSON.stringify(reclickExistingState));
    }
    console.log('   ✅ Clicking an unselected existing text box selects the box on 1st click (preventing focus) and moves with Left/Right arrows!');

    console.log('6. Testing "Center on Page" button (#prop-center-page-btn) using actual text width (NOT text box width)...');
    const centerResult = await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const ann = window.annotationManager.getSelectedAnnotation();
      const pageSize = window.pdfEngine.getPageSize(0);
      const pageWidth = pageSize.width;
      const actualTextWidth = window.canvasController.measureActualTextWidth(ann);
      const boxWidth = ann.width;

      const centerBtn = document.querySelector('#prop-center-page-btn');
      if (!centerBtn) throw new Error('#prop-center-page-btn not found in properties bar!');
      centerBtn.click();
      await sleep(50);

      const newX = ann.x;
      const expectedXByText = +(((pageWidth - actualTextWidth) / 2).toFixed(2));
      const wrongXByBox = +(((pageWidth - boxWidth) / 2).toFixed(2));
      const textCenterOnPage = newX + actualTextWidth / 2;
      const pageCenter = pageWidth / 2;
      const el = document.querySelector('.pdf-text-element[data-id="' + ann.id + '"]');

      return {
        text: ann.text,
        pageWidth,
        actualTextWidth,
        boxWidth,
        newX,
        expectedXByText,
        wrongXByBox,
        textCenterOnPage,
        pageCenter,
        domLeftPx: parseFloat(el.style.left)
      };
    `);
    console.log('   Center on Page result:', centerResult);
    if (Math.abs(centerResult.newX - centerResult.expectedXByText) > 0.05) {
      throw new Error(`Expected newX=${centerResult.expectedXByText} (centered by actual text width), got ${centerResult.newX}`);
    }
    if (Math.abs(centerResult.textCenterOnPage - centerResult.pageCenter) > 0.05) {
      throw new Error(`Expected textCenterOnPage=${centerResult.pageCenter}, got ${centerResult.textCenterOnPage}`);
    }
    if (Math.abs(centerResult.newX - centerResult.wrongXByBox) < 0.5) {
      throw new Error('Text was centered using boxWidth instead of actualTextWidth!');
    }
    console.log('   ✅ "Center on Page" centered the text accurately using actual text width (NOT text box width)!');

    ws.close();
    console.log('🎉 ALL TWO-STAGE TEXT CLICK & CENTER ON PAGE TESTS PASSED! 🎉');
  } finally {
    chrome.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testTextClickAndCenter().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
