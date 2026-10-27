const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Immediate Blank Slot on "+ New" Click');
  console.log('====================================================');

  const PORT = 29950 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-blank-slot-');
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
        if (window.uiController && window.sigPadController) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Application loaded.');

    // Step 1: Open dialog and draw initial signature (Sig 1)
    console.log('\n--- Step 1: Create Initial Signature 1 ---');
    const step1Result = await evaluate(`(() => {
      localStorage.clear();
      const sp = window.sigPadController;
      sp.open();

      sp.drawColor = '#0f172a';
      sp.startDrawing({ clientX: 50, clientY: 50, pointerId: 1 });
      sp.drawMove({ clientX: 100, clientY: 80 });
      sp.stopDrawing();

      return {
        activeSlotId: sp.activeSlotId,
        savedCount: sp.savedSignatures.length,
        hasThumbnail: !!sp.dialog.querySelector('.sig-saved-slot img.sig-slot-thumbnail')
      };
    })()`);
    console.log('Step 1 result:', step1Result);
    if (step1Result.savedCount !== 1 || !step1Result.hasThumbnail) {
      throw new Error('Step 1 failed: Initial signature was not created');
    }
    console.log('✅ Initial signature created.');

    // Step 2: Click "+ New" and check IMMEDIATELY before drawing any strokes
    console.log('\n--- Step 2: Click "+ New" -> Verify Blank Slot Inserted Immediately on LEFT ---');
    const step2Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      const initialSigId = sp.savedSignatures[0].id;

      // CLICK + NEW
      sp.newSlotBtn.click();

      // Check DOM IMMEDIATELY (no drawing yet!)
      const slots = sp.dialog.querySelectorAll('.sig-saved-slot');
      const firstSlot = slots[0];
      const secondSlot = slots[1];

      return {
        totalSlotsInDom: slots.length,
        firstSlotId: firstSlot ? firstSlot.dataset.slotId : null,
        secondSlotId: secondSlot ? secondSlot.dataset.slotId : null,
        initialSigId,
        firstSlotIsActive: firstSlot ? firstSlot.classList.contains('active') : false,
        secondSlotIsActive: secondSlot ? secondSlot.classList.contains('active') : false,
        firstSlotHasBlankEl: !!(firstSlot && firstSlot.querySelector('.sig-slot-blank')),
        firstSlotHasThumbnail: !!(firstSlot && firstSlot.querySelector('img.sig-slot-thumbnail')),
        firstSlotBg: firstSlot ? window.getComputedStyle(firstSlot).backgroundColor : null,
        hasDeleteBtn: !!(firstSlot && firstSlot.querySelector('.sig-slot-delete-btn'))
      };
    })()`);
    console.log('Step 2 result:', step2Result);

    if (step2Result.totalSlotsInDom !== 2) {
      throw new Error('Step 2 failed: Expected 2 slots in DOM immediately after clicking + New, got ' + step2Result.totalSlotsInDom);
    }
    if (!step2Result.firstSlotIsActive || step2Result.secondSlotIsActive) {
      throw new Error('Step 2 failed: Newly inserted leftmost slot is not active');
    }
    if (step2Result.secondSlotId !== step2Result.initialSigId) {
      throw new Error('Step 2 failed: Older signature is not in second position (to the right of new slot)');
    }
    if (!step2Result.firstSlotHasBlankEl || step2Result.firstSlotHasThumbnail) {
      throw new Error('Step 2 failed: Newly inserted slot is not blank');
    }
    if (step2Result.firstSlotBg !== 'rgb(255, 255, 255)') {
      throw new Error('Step 2 failed: Blank slot background is not white');
    }
    if (!step2Result.hasDeleteBtn) {
      throw new Error('Step 2 failed: Blank slot does not have delete x button');
    }
    console.log('✅ Blank slot was IMMEDIATELY inserted on the left upon clicking "+ New" with white card and active border.');

    // Capture visual screenshot of modal with blank slot
    const screenshotRes = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = '/Users/pumisake/.gemini/antigravity/brain/8d574bde-c467-4266-b89b-4291ddbe427a/sig-blank-slot-preview.png';
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'));
    console.log('📸 Screenshot saved to:', screenshotPath);

    // Step 3: Draw in the blank slot -> Verify thumbnail updates
    console.log('\n--- Step 3: Draw in the Blank Slot -> Verify Thumbnail Updates Live ---');
    const step3Result = await evaluate(`(() => {
      const sp = window.sigPadController;

      sp.drawColor = '#2563eb';
      sp.startDrawing({ clientX: 60, clientY: 60, pointerId: 1 });
      sp.drawMove({ clientX: 110, clientY: 90 });
      sp.stopDrawing();

      const slots = sp.dialog.querySelectorAll('.sig-saved-slot');
      const firstSlot = slots[0];

      return {
        firstSlotHasThumbnail: !!(firstSlot && firstSlot.querySelector('img.sig-slot-thumbnail')),
        thumbnailSrcLength: firstSlot && firstSlot.querySelector('img.sig-slot-thumbnail') ? firstSlot.querySelector('img.sig-slot-thumbnail').src.length : 0,
        totalSaved: sp.savedSignatures.length,
        isFirstActive: firstSlot ? firstSlot.classList.contains('active') : false
      };
    })()`);
    console.log('Step 3 result:', step3Result);
    if (!step3Result.firstSlotHasThumbnail || step3Result.thumbnailSrcLength < 100) {
      throw new Error('Step 3 failed: Thumbnail did not update on drawing');
    }
    console.log('✅ Thumbnail in leftmost slot updated with drawing strokes.');

    // Step 4: Click "+ New", then click an existing slot without drawing -> Discard empty blank slot
    console.log('\n--- Step 4: Abandon Empty Blank Slot -> Cleans Up Cleanly ---');
    const step4Result = await evaluate(`(() => {
      const sp = window.sigPadController;

      // Click + New -> creates 3rd slot (blank)
      sp.newSlotBtn.click();
      const countAfterNew = sp.dialog.querySelectorAll('.sig-saved-slot').length;

      // Click the 2nd slot (existing) without drawing in 3rd
      const secondSlot = sp.dialog.querySelectorAll('.sig-saved-slot')[1];
      secondSlot.click();

      const countAfterAbandon = sp.dialog.querySelectorAll('.sig-saved-slot').length;

      return {
        countAfterNew,
        countAfterAbandon,
        activeSlotId: sp.activeSlotId
      };
    })()`);
    console.log('Step 4 result:', step4Result);
    if (step4Result.countAfterNew !== 3 || step4Result.countAfterAbandon !== 2) {
      throw new Error('Step 4 failed: Empty blank slot was not discarded when switching to existing slot');
    }
    console.log('✅ Abandoned empty blank slot was cleaned up without cluttering saved signatures.');

    // Step 5: Click "+ New", then click delete button on blank slot
    console.log('\n--- Step 5: Delete Blank Slot via Delete Button ---');
    const step5Result = await evaluate(`(() => {
      const sp = window.sigPadController;

      // Click + New
      sp.newSlotBtn.click();
      const slotsBefore = sp.dialog.querySelectorAll('.sig-saved-slot');
      const blankDelBtn = slotsBefore[0].querySelector('.sig-slot-delete-btn');

      // Click delete x
      blankDelBtn.click();

      const slotsAfter = sp.dialog.querySelectorAll('.sig-saved-slot');

      return {
        countBefore: slotsBefore.length,
        countAfter: slotsAfter.length,
        activeSlotId: sp.activeSlotId
      };
    })()`);
    console.log('Step 5 result:', step5Result);
    if (step5Result.countBefore !== 3 || step5Result.countAfter !== 2) {
      throw new Error('Step 5 failed: Blank slot delete button did not remove slot');
    }
    console.log('✅ Blank slot delete button removed blank slot cleanly.');

    console.log('\n====================================================');
    console.log('🎉 ALL IMMEDIATE BLANK SLOT TESTS PASSED!');
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
