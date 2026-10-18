const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testShiftSelectMove() {
  console.log('--- Starting Shift Select & Move Together Test Suite ---');
  const PORT = 27000 + Math.floor(Math.random() * 5000);
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

    console.log('1. Loading test_case1.pdf into the editor...');
    await evaluate(`while (!window.uiController) await new Promise(r => setTimeout(r, 50));`);
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    console.log('2. Spawning 3 text boxes: Box A (100, 100), Box B (100, 200), Box C (100, 300)...');
    const ids = await evaluate(`
      const a = window.annotationManager.addAnnotation({
        pageIndex: 0,
        type: 'text',
        x: 100,
        y: 100,
        width: 150,
        height: 20,
        fontSize: 14,
        text: "Line 1 - Header Title"
      });
      const b = window.annotationManager.addAnnotation({
        pageIndex: 0,
        type: 'text',
        x: 100,
        y: 200,
        width: 150,
        height: 20,
        fontSize: 14,
        text: "Line 2 - Subtitle Address"
      });
      const c = window.annotationManager.addAnnotation({
        pageIndex: 0,
        type: 'text',
        x: 100,
        y: 300,
        width: 150,
        height: 20,
        fontSize: 14,
        text: "Line 3 - Phone Number"
      });
      window.canvasController.syncTextElements();
      return { idA: a.id, idB: b.id, idC: c.id };
    `);
    console.log('   Spawned annotations:', ids);

    console.log('3. Selecting Box A initially...');
    await evaluate(`
      window.annotationManager.selectAnnotation("${ids.idA}", false);
    `);
    const initialSelection = await evaluate(`
      return {
        selectedIds: Array.from(window.annotationManager.selectedAnnotationIds),
        primaryId: window.annotationManager.selectedAnnotationId,
        domSelectedCount: document.querySelectorAll('.pdf-text-element.selected').length
      };
    `);
    console.log('   Initial selection state:', initialSelection);
    if (initialSelection.domSelectedCount !== 1 || initialSelection.primaryId !== ids.idA) {
      throw new Error('Expected only Box A to be selected initially!');
    }
    console.log('   ✅ Single selection confirmed for Box A.');

    console.log('4. Shift-selecting Box B (holding Shift key)...');
    await evaluate(`
      const elB = document.querySelector('.pdf-text-element[data-id="${ids.idB}"] .pdf-text-content');
      elB.dispatchEvent(new PointerEvent('pointerdown', { shiftKey: true, bubbles: true }));
    `);
    const twoSelected = await evaluate(`
      return {
        selectedIds: Array.from(window.annotationManager.selectedAnnotationIds),
        domSelectedCount: document.querySelectorAll('.pdf-text-element.selected').length,
        isASelected: window.annotationManager.isSelected("${ids.idA}"),
        isBSelected: window.annotationManager.isSelected("${ids.idB}"),
        isCSelected: window.annotationManager.isSelected("${ids.idC}")
      };
    `);
    console.log('   After Shift-selecting Box B:', twoSelected);
    if (twoSelected.domSelectedCount !== 2 || !twoSelected.isASelected || !twoSelected.isBSelected || twoSelected.isCSelected) {
      throw new Error('Expected both Box A and Box B to be selected, Box C unselected!');
    }
    console.log('   ✅ Both Box A and Box B are selected together via Shift-select.');

    console.log('5. Shift-selecting Box C (now all 3 selected)...');
    await evaluate(`
      const elC = document.querySelector('.pdf-text-element[data-id="${ids.idC}"] .pdf-text-content');
      elC.dispatchEvent(new PointerEvent('pointerdown', { shiftKey: true, bubbles: true }));
    `);
    const threeSelected = await evaluate(`
      return {
        selectedIds: Array.from(window.annotationManager.selectedAnnotationIds),
        domSelectedCount: document.querySelectorAll('.pdf-text-element.selected').length,
        dragBarsCount: document.querySelectorAll('.pdf-text-drag-bar').length
      };
    `);
    console.log('   After Shift-selecting Box C:', threeSelected);
    if (threeSelected.domSelectedCount !== 3 || threeSelected.selectedIds.length !== 3) {
      throw new Error('Expected all 3 boxes to be selected!');
    }
    if (threeSelected.dragBarsCount !== 0) {
      throw new Error('Expected 0 drag bars in DOM!');
    }
    console.log('   ✅ All 3 boxes selected together with 0 black bars in DOM!');

    console.log('6. Testing Keyboard Arrow Key Move Together (+5px Y on ArrowDown)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    `);
    const afterDown = await evaluate(`
      const a = window.annotationManager.getAnnotation("${ids.idA}");
      const b = window.annotationManager.getAnnotation("${ids.idB}");
      const c = window.annotationManager.getAnnotation("${ids.idC}");
      return {
        yA: a.y, yB: b.y, yC: c.y,
        domTopA: parseFloat(document.querySelector('.pdf-text-element[data-id="${ids.idA}"]').style.top),
        domTopB: parseFloat(document.querySelector('.pdf-text-element[data-id="${ids.idB}"]').style.top),
        domTopC: parseFloat(document.querySelector('.pdf-text-element[data-id="${ids.idC}"]').style.top)
      };
    `);
    console.log('   Positions after ArrowDown (+5px):', afterDown);
    if (afterDown.yA !== 105 || afterDown.yB !== 205 || afterDown.yC !== 305) {
      throw new Error('All 3 boxes should have moved down by 5px together!');
    }
    if (afterDown.domTopA !== 105 || afterDown.domTopB !== 205 || afterDown.domTopC !== 305) {
      throw new Error('DOM styles should reflect the +5px movement!');
    }
    console.log('   ✅ Keyboard ArrowDown moved ALL 3 selected text boxes together by 5px.');

    console.log('7. Testing Shift + ArrowUp Micro-Move Together (-1px Y)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    `);
    const afterShiftUp = await evaluate(`
      const a = window.annotationManager.getAnnotation("${ids.idA}");
      const b = window.annotationManager.getAnnotation("${ids.idB}");
      const c = window.annotationManager.getAnnotation("${ids.idC}");
      return { yA: a.y, yB: b.y, yC: c.y };
    `);
    console.log('   Positions after Shift+ArrowUp (-1px):', afterShiftUp);
    if (afterShiftUp.yA !== 104 || afterShiftUp.yB !== 204 || afterShiftUp.yC !== 304) {
      throw new Error('All 3 boxes should have micro-stepped up by 1px together!');
    }
    console.log('   ✅ Shift + ArrowUp micro-stepped ALL 3 boxes together by 1px.');

    console.log('8. Testing Mouse Pointer Dragging Together (+30px X, +40px Y)...');
    await evaluate(`
      const elB = document.querySelector('.pdf-text-element[data-id="${ids.idB}"] .pdf-text-content');
      const rect = elB.getBoundingClientRect();
      const startX = rect.left + 10;
      const startY = rect.top + 5;

      // Pointerdown on selected textarea (not focused yet, part of multi-select)
      elB.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true }));
      // Move by >3px to trigger drag
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: startX + 30, clientY: startY + 40, bubbles: true }));
      // End drag
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: startX + 30, clientY: startY + 40, bubbles: true }));
    `);
    const afterDrag = await evaluate(`
      const a = window.annotationManager.getAnnotation("${ids.idA}");
      const b = window.annotationManager.getAnnotation("${ids.idB}");
      const c = window.annotationManager.getAnnotation("${ids.idC}");
      return {
        xA: a.x, yA: a.y,
        xB: b.x, yB: b.y,
        xC: c.x, yC: c.y,
        domLeftA: parseFloat(document.querySelector('.pdf-text-element[data-id="${ids.idA}"]').style.left),
        domTopA: parseFloat(document.querySelector('.pdf-text-element[data-id="${ids.idA}"]').style.top)
      };
    `);
    console.log('   Positions after Drag (+30 X, +40 Y):', afterDrag);
    if (afterDrag.xA !== 130 || afterDrag.yA !== 144) {
      throw new Error(`Box A should be at (130, 144), got (${afterDrag.xA}, ${afterDrag.yA})`);
    }
    if (afterDrag.xB !== 130 || afterDrag.yB !== 244) {
      throw new Error(`Box B should be at (130, 244), got (${afterDrag.xB}, ${afterDrag.yB})`);
    }
    if (afterDrag.xC !== 130 || afterDrag.yC !== 344) {
      throw new Error(`Box C should be at (130, 344), got (${afterDrag.xC}, ${afterDrag.yC})`);
    }
    console.log('   ✅ Dragging ONE drag bar moved ALL 3 selected text boxes together seamlessly!');

    console.log('9. Testing Shift-click toggle off on Box B...');
    await evaluate(`
      const elB = document.querySelector('.pdf-text-element[data-id="${ids.idB}"] .pdf-text-content');
      elB.dispatchEvent(new PointerEvent('pointerdown', { shiftKey: true, bubbles: true }));
    `);
    const afterToggleOff = await evaluate(`
      return {
        isASelected: window.annotationManager.isSelected("${ids.idA}"),
        isBSelected: window.annotationManager.isSelected("${ids.idB}"),
        isCSelected: window.annotationManager.isSelected("${ids.idC}"),
        count: window.annotationManager.getSelectedAnnotations().length
      };
    `);
    console.log('   After toggling off Box B:', afterToggleOff);
    if (afterToggleOff.isBSelected || !afterToggleOff.isASelected || !afterToggleOff.isCSelected || afterToggleOff.count !== 2) {
      throw new Error('Box B should be unselected while Box A and Box C remain selected!');
    }

    console.log('   Moving remaining selected boxes (A and C) with ArrowRight (+5px X)...');
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    `);
    const partialMoveCheck = await evaluate(`
      const a = window.annotationManager.getAnnotation("${ids.idA}");
      const b = window.annotationManager.getAnnotation("${ids.idB}");
      const c = window.annotationManager.getAnnotation("${ids.idC}");
      return { xA: a.x, xB: b.x, xC: c.x };
    `);
    console.log('   Positions after partial group move:', partialMoveCheck);
    if (partialMoveCheck.xA !== 135 || partialMoveCheck.xC !== 135) {
      throw new Error('Boxes A and C should have moved to X=135!');
    }
    if (partialMoveCheck.xB !== 130) {
      throw new Error('Unselected Box B should have remained at X=130!');
    }
    console.log('   ✅ Box A and C moved together while unselected Box B remained static.');

    console.log('10. Testing Deselect All (clicking empty canvas)...');
    await evaluate(`
      window.annotationManager.deselectAll();
    `);
    const finalCheck = await evaluate(`
      return {
        selectedCount: window.annotationManager.getSelectedAnnotations().length,
        domSelectedCount: document.querySelectorAll('.pdf-text-element.selected').length
      };
    `);
    console.log('   Final deselection check:', finalCheck);
    if (finalCheck.selectedCount !== 0 || finalCheck.domSelectedCount !== 0) {
      throw new Error('All boxes should be deselected!');
    }
    console.log('   ✅ All elements cleanly deselected.');

    console.log('🎉 ALL SHIFT SELECT & MOVE TOGETHER TESTS PASSED SUCCESSFULLY! 🎉');

  } finally {
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
  }
}

testShiftSelectMove().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
