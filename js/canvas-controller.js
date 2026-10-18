/**
 * Canvas Controller
 * Handles user interactions on the page overlay (drawing, text creation, shape drafting, selecting, dragging, resizing).
 */

class CanvasController {
  constructor(container, annotationManager, pdfEngine) {
    this.container = container;
    this.annotationManager = annotationManager;
    this.pdfEngine = pdfEngine;

    this.activePageIndex = 0;
    this.zoom = 1.0;
    this.activeTool = 'select'; // 'select', 'pan', 'text', 'draw', 'highlighter', 'shapes', 'checkmark', 'cross', 'whiteout', 'blackout'
    this.shapeSubtype = 'rect'; // 'rect', 'circle', 'line', 'arrow'

    // Tool settings defaults
    this.toolSettings = {
      fontFamily: 'Helvetica',
      fontSize: 14,
      fontColor: '#000000',
      fontWeight: 'normal',
      fontStyle: 'normal',
      strokeColor: '#3b82f6',
      strokeWidth: 2,
      fillColor: 'transparent',
      opacity: 1.0,
      highlighterColor: '#fde047',
      highlighterOpacity: 0.45,
    };

    // Interaction states
    this.isInteracting = false;
    this.interactionType = null; // 'draw', 'shape', 'drag', 'resize'
    this.activeHandle = null;     // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'
    this.startPoint = { x: 0, y: 0 };
    this.currentPoint = { x: 0, y: 0 };
    this.freehandPoints = [];
    this.dragInitialBox = null;

    // Pan state
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.scrollStart = { left: 0, top: 0 };

    // Original text detection for "Edit Existing Text" mode
    this.cachedPageTextItems = [];

    // Inline text editor
    this.activeTextEditor = null;

    // Cached elements
    this.overlayCanvas = null;
    this.previewCanvas = null;
    this.selectionBoxEl = null;
    this.clipboard = null;
    this.pasteOffset = 0;

    // Bind event handlers
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);

    // Subscribe to annotation updates
    this.annotationManager.onChange(() => {
      this.render();
      this.updateSelectionBox();
    });

    this.annotationManager.onSelectionChange((selected) => {
      this.clearLivePreview();
      const allSelected = this.annotationManager.getSelectedAnnotations();
      if (allSelected.length === 0 && document.activeElement && document.activeElement.classList.contains('pdf-text-content')) {
        document.activeElement.blur();
      }
      if (this.container) {
        this.container.querySelectorAll('.pdf-text-element').forEach(el => {
          const isSel = this.annotationManager.isSelected(el.dataset.id);
          el.classList.toggle('selected', isSel);
        });
      }
      this.updateSelectionBox();
      this.syncTextElements();
    });

    window.addEventListener('keydown', this.handleKeyDown);

    // Global listener: clicking outside text elements / selection controls unselects
    document.addEventListener('pointerdown', (e) => {
      if (e.shiftKey) return;
      if (this.annotationManager.getSelectedAnnotations().length === 0) return;

      // Don't deselect if clicked inside text element, selection handles, or UI controls
      if (e.target.closest('.pdf-text-element') ||
          e.target.closest('.selection-box') ||
          e.target.closest('.app-toolbar') ||
          e.target.closest('.properties-bar') ||
          e.target.closest('.app-sidebar') ||
          e.target.closest('dialog') ||
          e.target.closest('.dropdown-menu')) {
        return;
      }

      // If clicked on an original PDF text item in text/edit-pdf-text mode, handlePointerDown handles replacement
      if ((this.activeTool === 'edit-pdf-text' || this.activeTool === 'text') && e.target.closest('.annotation-layer')) {
        return;
      }

      if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pdf-text-content')) {
        document.activeElement.blur();
      }
      this.annotationManager.deselectAll();
    });
  }

  // Load original text items for active page
  async loadTextItemsForActivePage() {
    this.cachedPageTextItems = await this.pdfEngine.getTextItems(this.activePageIndex);
  }

  findTextItemAt(pt) {
    if (!this.cachedPageTextItems || this.cachedPageTextItems.length === 0) return null;
    const padX = 4;
    const padY = 1;
    let closestItem = null;
    let closestDist = Infinity;

    for (const item of this.cachedPageTextItems) {
      if (pt.x >= item.x - padX && pt.x <= item.x + item.width + padX &&
          pt.y >= item.y - padY && pt.y <= item.y + item.height + padY) {
        const cx = item.x + item.width / 2;
        const cy = item.y + item.height / 2;
        const dist = Math.hypot(pt.x - cx, pt.y - cy);
        if (dist < closestDist) {
          closestDist = dist;
          closestItem = item;
        }
      }
    }
    return closestItem;
  }

  // Render hover highlight over existing text item
  renderHoverTextHighlight(hit) {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    ctx.save();
    ctx.scale(dpr * this.zoom, dpr * this.zoom);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.fillRect(hit.x - 1, hit.y, hit.width + 2, hit.height);
    ctx.strokeRect(hit.x - 1, hit.y, hit.width + 2, hit.height);
    ctx.restore();
  }

  // Set active tool
  setTool(tool, subtype = null) {
    this.clearLivePreview();
    if (this.activeTextEditor) {
      this.commitTextEditor();
    }
    this.activeTool = tool;
    if (subtype) {
      this.shapeSubtype = subtype;
    }
    if (tool !== 'select') {
      this.annotationManager.deselectAll();
    }
    if (tool === 'edit-pdf-text' || tool === 'text') {
      this.loadTextItemsForActivePage();
    }

    const viewport = document.querySelector('.app-viewport');
    if (viewport) {
      viewport.className = `app-viewport mode-${tool}`;
    }
  }

  // Set active page
  setActivePage(pageIndex) {
    if (this.activePageIndex !== pageIndex) {
      if (this.activeTextEditor) {
        this.commitTextEditor();
      }
      this.activePageIndex = pageIndex;
      this.annotationManager.deselectAll();
    }
  }

  // Update zoom
  setZoom(zoom) {
    this.zoom = zoom;
    this.render();
    this.updateSelectionBox();
  }

  // Attach overlay elements to the active page container
  attachToPage(pageWrapper, pageIndex) {
    this.activePageIndex = pageIndex;

    // Clear previous overlays
    const existingOverlay = pageWrapper.querySelector('.annotation-layer');
    if (existingOverlay) existingOverlay.remove();

    const layer = document.createElement('div');
    layer.className = 'annotation-layer';

    // Canvas for finished annotations (shapes, strokes, stamps, images, whiteout)
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'annotation-canvas';

    // Canvas for live drafting / preview
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.className = 'annotation-canvas preview';

    // Persistent DOM layer for text annotations (PDFescape Architecture)
    this.textLayer = document.createElement('div');
    this.textLayer.className = 'text-elements-layer';

    layer.appendChild(this.overlayCanvas);
    layer.appendChild(this.previewCanvas);
    layer.appendChild(this.textLayer);
    pageWrapper.appendChild(layer);

    // Pointer events on annotation layer
    layer.addEventListener('pointerdown', this.handlePointerDown);
    layer.addEventListener('pointermove', this.handlePointerMove);
    layer.addEventListener('pointerup', this.handlePointerUp);
    layer.addEventListener('pointercancel', this.handlePointerUp);

    // Double-click on page creates a text box (PDFescape Desktop & Acrobat feature)
    layer.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pdf-text-element')) return;
      const pt = this.screenToPdf(e);
      this.createTextAnnotationAt(pt.x, pt.y);
    });

    this.render();
    this.updateSelectionBox();
    this.loadTextItemsForActivePage();
  }

  // Screen point to PDF unscaled point (72 DPI)
  screenToPdf(e) {
    const layer = this.container.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"] .annotation-layer`);
    if (!layer) return { x: 0, y: 0 };

    const rect = layer.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    return {
      x: screenX / this.zoom,
      y: screenY / this.zoom,
    };
  }

  // Pointer Down
  async handlePointerDown(e) {
    // Only primary button
    if (e.button !== 0) return;

    const pt = this.screenToPdf(e);

    // 1. EDIT ORIGINAL PDF TEXT TOOL OR TEXT TOOL OVER EXISTING TEXT (REAL REPLACEMENT)
    // Check hitText FIRST so covered or touching text elements never block clicking adjacent lines!
    if (this.activeTool === 'edit-pdf-text' || this.activeTool === 'text') {
      const hitText = this.findTextItemAt(pt);
      if (hitText) {
        const isShiftMultiSelect = !!e.shiftKey;
        const prevSelectedIds = isShiftMultiSelect
          ? this.annotationManager.getSelectedAnnotations().map(a => a.id)
          : [];

        // Blur active text element and clear hover preview
        if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pdf-text-content')) {
          try { document.activeElement.setSelectionRange(0, 0); } catch (err) {}
          document.activeElement.blur();
        }
        this.clearLivePreview();
        if (this.activeTextEditor) {
          this.commitTextEditor();
        }

        let wasRedacted = false;
        try {
          wasRedacted = await this.pdfEngine.redactTextFromPage(this.activePageIndex, hitText.str, hitText.rawTx, hitText.rawTy);
        } catch (err) {
          console.warn('Real text redaction error:', err);
        }

        // 2. Re-render the canvas so the original text immediately vanishes from the canvas!
        if (wasRedacted) {
          const pageWrapper = this.container.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
          if (pageWrapper) {
            const canvas = pageWrapper.querySelector('.pdf-canvas');
            if (canvas) {
              await this.pdfEngine.renderPage(this.activePageIndex, canvas, this.zoom);
            }
          }
          await this.loadTextItemsForActivePage();
        }

        // 3. Spawn real replacement text element with snug vertical dimensions and enough width so browser font never scrolls
        const spawnWidth = Math.max(Math.round(hitText.width * 1.15 + 14), 28);
        const spawnHeight = Math.max(Math.round(hitText.height || hitText.fontSize * 1.15), 10);

        this.createTextAnnotationAt(hitText.x, hitText.y, hitText.str, {
          width: spawnWidth,
          height: spawnHeight,
          fontSize: hitText.fontSize,
          fontFamily: hitText.fontFamily || 'Helvetica',
          fontColor: hitText.fontColor || '#000000',
          backgroundColor: wasRedacted ? 'transparent' : '#ffffff', // Transparent if redacted, whiteout fallback
          fontWeight: hitText.fontWeight || 'normal',
          fontStyle: hitText.fontStyle || 'normal',
          isOriginalReplacement: true,
          originalText: hitText.str,
          baselineY: hitText.baselineY,
          appendSelection: isShiftMultiSelect,
          prevSelectedIds,
        });
        return;
      }
    }

    // If clicking directly inside an already created text element, do NOT intercept or cancel
    if (e.target.closest('.pdf-text-element')) {
      return;
    }

    // Blur any active text element and clear hover preview
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pdf-text-content')) {
      document.activeElement.blur();
    }
    this.clearLivePreview();

    // If currently editing text and clicked outside, commit first
    if (this.activeTextEditor) {
      this.commitTextEditor();
    }

    this.startPoint = pt;
    this.currentPoint = pt;

    // 2. SELECT TOOL
    if (this.activeTool === 'select') {
      const selected = this.annotationManager.getSelectedAnnotation();

      // Check if clicking a resize handle
      if (e.target.classList.contains('selection-handle')) {
        this.isInteracting = true;
        this.interactionType = 'resize';
        this.activeHandle = e.target.dataset.handle;
        this.dragInitialBox = {
          x: selected.x,
          y: selected.y,
          width: selected.width,
          height: selected.height,
        };
        e.target.setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }

      // Check if clicking inside active selection box to drag
      if (e.target.closest('.selection-box')) {
        this.isInteracting = true;
        this.interactionType = 'drag';
        this.dragInitialBox = {
          x: selected.x,
          y: selected.y,
          width: selected.width,
          height: selected.height,
        };
        e.target.closest('.selection-box').setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }

      // Hit-test annotations on active page
      const hit = this.hitTest(pt);
      if (hit) {
        if (e.shiftKey) {
          this.annotationManager.selectAnnotation(hit.id, true);
        } else {
          if (!this.annotationManager.isSelected(hit.id)) {
            this.annotationManager.selectAnnotation(hit.id, false);
          }
        }
        this.isInteracting = true;
        this.interactionType = 'drag';
        const selectedList = this.annotationManager.getSelectedAnnotations();
        const itemsToDrag = selectedList.length > 0 ? selectedList : [hit];
        this.dragInitialBoxes = itemsToDrag.map(a => ({
          ann: a,
          initX: a.x,
          initY: a.y,
          initBaselineY: a.baselineY,
          el: this.container ? this.container.querySelector(`.pdf-text-element[data-id="${a.id}"]`) : null
        }));
        this.dragInitialBox = {
          x: hit.x,
          y: hit.y,
          width: hit.width,
          height: hit.height,
        };
        e.target.setPointerCapture(e.pointerId);
      } else {
        if (!e.shiftKey) {
          this.annotationManager.deselectAll();
        }
      }
      return;
    }

    // 3. PAN TOOL
    if (this.activeTool === 'pan') {
      this.isPanning = true;
      const viewport = document.querySelector('.app-viewport');
      this.panStart = { x: e.clientX, y: e.clientY };
      this.scrollStart = { left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.classList.add('panning');
      e.target.setPointerCapture(e.pointerId);
      return;
    }

    // 4. TEXT TOOL ON EMPTY SPACE
    if (this.activeTool === 'text') {
      const hadSelected = this.annotationManager.getSelectedAnnotations().length > 0;
      if (hadSelected) {
        this.annotationManager.deselectAll();
        return;
      }
      this.createTextAnnotationAt(pt.x, pt.y);
      return;
    }

    // 4b. EDIT ORIGINAL TEXT TOOL ON EMPTY SPACE
    if (this.activeTool === 'edit-pdf-text') {
      this.annotationManager.deselectAll();
      return;
    }

    // 5. CHECKMARK & CROSS (Single click stamp)
    if (this.activeTool === 'checkmark' || this.activeTool === 'cross') {
      const size = 24;
      this.annotationManager.addAnnotation({
        pageIndex: this.activePageIndex,
        type: this.activeTool,
        x: pt.x - size / 2,
        y: pt.y - size / 2,
        width: size,
        height: size,
        strokeColor: this.activeTool === 'checkmark' ? '#10b981' : '#ef4444',
        strokeWidth: 2.5,
      });
      return;
    }

    // 6. DRAW & HIGHLIGHTER
    if (this.activeTool === 'draw' || this.activeTool === 'highlighter') {
      this.isInteracting = true;
      this.interactionType = 'draw';
      this.freehandPoints = [pt];
      e.target.setPointerCapture(e.pointerId);
      return;
    }

    // 7. SHAPES, WHITEOUT, BLACKOUT
    if (this.activeTool === 'shapes' || this.activeTool === 'whiteout' || this.activeTool === 'blackout') {
      this.isInteracting = true;
      this.interactionType = 'shape';
      e.target.setPointerCapture(e.pointerId);
      return;
    }
  }

  // Pointer Move
  handlePointerMove(e) {
    if (this.isPanning) {
      const viewport = document.querySelector('.app-viewport');
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      viewport.scrollLeft = this.scrollStart.left - dx;
      viewport.scrollTop = this.scrollStart.top - dy;
      return;
    }

    // Hover highlight in edit-pdf-text or text mode
    if ((this.activeTool === 'edit-pdf-text' || this.activeTool === 'text') && !this.isInteracting) {
      const pt = this.screenToPdf(e);
      const hit = this.findTextItemAt(pt);
      if (hit) {
        this.renderHoverTextHighlight(hit);
      } else {
        this.clearLivePreview();
      }
      return;
    }

    if (!this.isInteracting) return;

    const pt = this.screenToPdf(e);
    this.currentPoint = pt;

    // Handle Dragging
    if (this.interactionType === 'drag') {
      const itemsToDrag = this.dragInitialBoxes && this.dragInitialBoxes.length > 0
        ? this.dragInitialBoxes
        : (this.dragInitialBox ? [{ ann: this.annotationManager.getSelectedAnnotation(), initX: this.dragInitialBox.x, initY: this.dragInitialBox.y }] : null);
      if (!itemsToDrag || itemsToDrag.length === 0) return;

      const dx = pt.x - this.startPoint.x;
      const dy = pt.y - this.startPoint.y;

      const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
      const maxX = (pageSize ? pageSize.width : 1000) - 20;
      const maxY = (pageSize ? pageSize.height : 1000) - 10;

      itemsToDrag.forEach(item => {
        if (!item.ann) return;
        item.ann.x = Math.max(0, Math.min(maxX, Math.round(item.initX + dx)));
        item.ann.y = Math.max(0, Math.min(maxY, Math.round(item.initY + dy)));
        if (item.ann.baselineY !== undefined && item.ann.baselineY !== null && item.initBaselineY !== undefined && item.initBaselineY !== null) {
          item.ann.baselineY = Math.round(item.initBaselineY + dy);
        }
        if (item.el) {
          item.el.style.left = `${Math.round(item.ann.x * this.zoom)}px`;
          item.el.style.top = `${Math.round(item.ann.y * this.zoom)}px`;
        }
      });

      this.render();
      this.updateSelectionBox();
      return;
    }

    // Handle Resizing
    if (this.interactionType === 'resize') {
      const selected = this.annotationManager.getSelectedAnnotation();
      if (!selected || !this.dragInitialBox) return;

      const dx = pt.x - this.startPoint.x;
      const dy = pt.y - this.startPoint.y;
      const init = this.dragInitialBox;

      let newX = init.x;
      let newY = init.y;
      let newW = init.width;
      let newH = init.height;

      const minSize = 10;

      if (this.activeHandle.includes('e')) {
        newW = Math.max(minSize, init.width + dx);
      }
      if (this.activeHandle.includes('s')) {
        newH = Math.max(minSize, init.height + dy);
      }
      if (this.activeHandle.includes('w')) {
        const potentialW = init.width - dx;
        if (potentialW >= minSize) {
          newW = potentialW;
          newX = init.x + dx;
        }
      }
      if (this.activeHandle.includes('n')) {
        const potentialH = init.height - dy;
        if (potentialH >= minSize) {
          newH = potentialH;
          newY = init.y + dy;
        }
      }

      selected.x = newX;
      selected.y = newY;
      selected.width = newW;
      selected.height = newH;
      this.render();
      this.updateSelectionBox();
      return;
    }

    // Handle Freehand Draw
    if (this.interactionType === 'draw') {
      this.freehandPoints.push(pt);
      this.renderLiveDrawPreview();
      return;
    }

    // Handle Shape / Whiteout / Blackout drafting
    if (this.interactionType === 'shape') {
      this.renderLiveShapePreview();
      return;
    }
  }

  // Pointer Up
  handlePointerUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      const viewport = document.querySelector('.app-viewport');
      if (viewport) viewport.classList.remove('panning');
      return;
    }

    if (!this.isInteracting) return;
    this.isInteracting = false;

    // Finish Drag / Resize: Commit history
    if (this.interactionType === 'drag' || this.interactionType === 'resize') {
      const count = this.dragInitialBoxes ? this.dragInitialBoxes.length : 1;
      this.annotationManager.pushHistory(`Transform ${count} Element${count > 1 ? 's' : ''}`);
      this.annotationManager.notifyChange('update');
      this.interactionType = null;
      this.activeHandle = null;
      this.dragInitialBox = null;
      this.dragInitialBoxes = null;
      return;
    }

    // Finish Freehand / Highlighter
    if (this.interactionType === 'draw') {
      if (this.freehandPoints.length > 1) {
        // Compute bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.freehandPoints.forEach(p => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });

        const isHighlighter = this.activeTool === 'highlighter';

        this.annotationManager.addAnnotation({
          pageIndex: this.activePageIndex,
          type: this.activeTool,
          x: minX,
          y: minY,
          width: Math.max(10, maxX - minX),
          height: Math.max(10, maxY - minY),
          points: this.freehandPoints,
          strokeColor: isHighlighter ? this.toolSettings.highlighterColor : this.toolSettings.strokeColor,
          strokeWidth: isHighlighter ? 18 : this.toolSettings.strokeWidth,
          opacity: isHighlighter ? this.toolSettings.highlighterOpacity : 1.0,
        });
      }
      this.clearLivePreview();
      this.freehandPoints = [];
      this.interactionType = null;
      return;
    }

    // Finish Shape / Whiteout / Blackout
    if (this.interactionType === 'shape') {
      const x = Math.min(this.startPoint.x, this.currentPoint.x);
      const y = Math.min(this.startPoint.y, this.currentPoint.y);
      const width = Math.abs(this.currentPoint.x - this.startPoint.x);
      const height = Math.abs(this.currentPoint.y - this.startPoint.y);

      if (width > 4 || height > 4) {
        if (this.activeTool === 'whiteout' || this.activeTool === 'blackout') {
          this.annotationManager.addAnnotation({
            pageIndex: this.activePageIndex,
            type: this.activeTool,
            x,
            y,
            width: Math.max(10, width),
            height: Math.max(10, height),
          });
        } else if (this.activeTool === 'shapes') {
          this.annotationManager.addAnnotation({
            pageIndex: this.activePageIndex,
            type: this.shapeSubtype,
            x,
            y,
            width: Math.max(8, width),
            height: Math.max(8, height),
            strokeColor: this.toolSettings.strokeColor,
            strokeWidth: this.toolSettings.strokeWidth,
            fillColor: this.toolSettings.fillColor,
            opacity: this.toolSettings.opacity,
          });
        }
      }

      this.clearLivePreview();
      this.interactionType = null;
      return;
    }
  }

  // Hit test annotations on active page
  hitTest(pt) {
    const annotations = this.annotationManager.getAnnotationsForPage(this.activePageIndex);
    // Iterate in reverse (top-most first)
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.type === 'text') continue; // Handled directly by DOM text elements layer
      // Padding for small lines/strokes
      const pad = 6;
      if (pt.x >= a.x - pad && pt.x <= a.x + a.width + pad &&
          pt.y >= a.y - pad && pt.y <= a.y + a.height + pad) {
        return a;
      }
    }
    return null;
  }

  // Move text element with keyboard arrow keys
  moveTextAnnotationBy(ann, deltaX, deltaY) {
    this.moveTextAnnotationsBy([ann], deltaX, deltaY);
  }

  // Move multiple text elements with keyboard arrow keys together
  moveTextAnnotationsBy(annotations, deltaX, deltaY) {
    if (!annotations || annotations.length === 0) return;
    const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
    const maxX = (pageSize ? pageSize.width : 1000) - 20;
    const maxY = (pageSize ? pageSize.height : 1000) - 10;

    annotations.forEach(ann => {
      if (ann.type !== 'text') return;
      ann.x = Math.max(0, Math.min(maxX, Math.round(ann.x + deltaX)));
      ann.y = Math.max(0, Math.min(maxY, Math.round(ann.y + deltaY)));
      if (ann.baselineY !== undefined && ann.baselineY !== null) {
        ann.baselineY = Math.round(ann.baselineY + deltaY);
      }

      const el = this.container ? this.container.querySelector(`.pdf-text-element[data-id="${ann.id}"]`) : null;
      if (el) {
        el.style.left = `${Math.round(ann.x * this.zoom)}px`;
        el.style.top = `${Math.round(ann.y * this.zoom)}px`;
      }
    });

    this.updateSelectionBox();
    this.annotationManager.notifyChange('update');

    clearTimeout(this._nudgeHistoryTimer);
    this._nudgeHistoryTimer = setTimeout(() => {
      const count = annotations.length;
      this.annotationManager.pushHistory(`Move ${count} Text Element${count > 1 ? 's' : ''}`);
    }, 400);
  }

  // Keyboard shortcut handler
  handleKeyDown(e) {
    // If typing in other inputs outside text element (e.g. document title, modal inputs), ignore
    const inTextContent = e.target.classList && e.target.classList.contains('pdf-text-content');
    if (['INPUT', 'SELECT'].includes(e.target.tagName) || (e.target.tagName === 'TEXTAREA' && !inTextContent)) {
      return;
    }

    // Arrow keys to move selected text annotations (single or multiple together)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const selectedList = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      if (selectedList.length > 0) {
        // If typing inside the textarea and only 1 box is selected, let Left/Right navigate cursor unless Alt is held
        if (inTextContent && selectedList.length === 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey) {
          return;
        }

        e.preventDefault();
        // Big move with normal key (5px), small with shift (1px)
        const step = e.shiftKey ? 1 : 5;
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        else if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;

        this.moveTextAnnotationsBy(selectedList, dx, dy);
        return;
      }
    }

    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    // Copy: Ctrl+C / Cmd+C
    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'c') {
      if (inTextContent && document.activeElement === e.target) {
        const ta = e.target;
        if (ta.selectionStart !== ta.selectionEnd) {
          return; // Let browser copy highlighted characters within textarea
        }
      }
      const selectedList = this.annotationManager.getSelectedAnnotations();
      if (selectedList.length > 0) {
        this.copyAnnotations(selectedList);
        e.preventDefault();
        return;
      }
    }

    // Paste: Ctrl+V / Cmd+V
    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'v') {
      if (inTextContent && document.activeElement === e.target) {
        return; // Let browser paste text string into focused textarea
      }
      if (this.clipboard && this.clipboard.length > 0) {
        this.pasteAnnotations();
        e.preventDefault();
        return;
      }
    }

    // If typing in textarea, don't trigger delete/duplicate shortcuts
    if (inTextContent) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selectedList = this.annotationManager.getSelectedAnnotations();
      if (selectedList.length > 0) {
        this.annotationManager.pushHistory(`Delete ${selectedList.length} element(s)`);
        selectedList.forEach(a => {
          this.annotationManager.deleteAnnotation(a.id);
        });
        this.annotationManager.deselectAll();
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      if (this.activeTextEditor) {
        this.commitTextEditor();
      } else {
        this.annotationManager.deselectAll();
      }
    } else if (isCtrlOrCmd && e.key.toLowerCase() === 'd') {
      const selectedList = this.annotationManager.getSelectedAnnotations();
      if (selectedList.length > 0) {
        this.copyAnnotations(selectedList);
        this.pasteAnnotations();
        e.preventDefault();
      }
    }
  }

  // Copy annotations to internal clipboard & system clipboard
  copyAnnotations(list) {
    if (!list || list.length === 0) return;
    this.clipboard = list.map(a => JSON.parse(JSON.stringify(a)));
    this.pasteOffset = 0;

    const textItems = list.filter(a => a.type === 'text' && a.text);
    if (textItems.length > 0 && navigator.clipboard && navigator.clipboard.writeText) {
      const textToCopy = textItems.map(a => a.text).join('\n');
      navigator.clipboard.writeText(textToCopy).catch(() => {});
    }
  }

  // Paste annotations from internal clipboard
  pasteAnnotations() {
    if (!this.clipboard || this.clipboard.length === 0) return;

    this.pasteOffset = (this.pasteOffset || 0) + 15;
    const offset = this.pasteOffset;

    const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
    const maxX = (pageSize ? pageSize.width : 1000) - 40;
    const maxY = (pageSize ? pageSize.height : 1000) - 20;

    const clonedList = this.clipboard.map(item => {
      const cloned = JSON.parse(JSON.stringify(item));
      cloned.id = 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
      cloned.pageIndex = this.activePageIndex;
      cloned.x = Math.max(0, Math.min(maxX, (cloned.x || 0) + offset));
      cloned.y = Math.max(0, Math.min(maxY, (cloned.y || 0) + offset));
      if (cloned.baselineY !== undefined && cloned.baselineY !== null) {
        cloned.baselineY += offset;
      }
      return cloned;
    });

    this.annotationManager.addAnnotations(clonedList, `Paste ${clonedList.length} Element${clonedList.length > 1 ? 's' : ''}`);
    this.render();
    this.updateSelectionBox();
    this.syncTextElements();
  }

  // Live Draw Preview
  renderLiveDrawPreview() {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    if (this.freehandPoints.length < 2) return;

    ctx.save();
    ctx.scale(dpr * this.zoom, dpr * this.zoom);
    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const isHighlighter = this.activeTool === 'highlighter';
    ctx.strokeStyle = isHighlighter ? this.toolSettings.highlighterColor : this.toolSettings.strokeColor;
    ctx.lineWidth = isHighlighter ? 18 : this.toolSettings.strokeWidth;
    ctx.globalAlpha = isHighlighter ? this.toolSettings.highlighterOpacity : 1.0;

    ctx.moveTo(this.freehandPoints[0].x, this.freehandPoints[0].y);
    for (let i = 1; i < this.freehandPoints.length; i++) {
      ctx.lineTo(this.freehandPoints[i].x, this.freehandPoints[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Live Shape Preview
  renderLiveShapePreview() {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    const x = Math.min(this.startPoint.x, this.currentPoint.x);
    const y = Math.min(this.startPoint.y, this.currentPoint.y);
    const width = Math.abs(this.currentPoint.x - this.startPoint.x);
    const height = Math.abs(this.currentPoint.y - this.startPoint.y);

    ctx.save();
    ctx.scale(dpr * this.zoom, dpr * this.zoom);

    if (this.activeTool === 'whiteout') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
    } else if (this.activeTool === 'blackout') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.fillRect(x, y, width, height);
    } else if (this.activeTool === 'shapes') {
      ctx.strokeStyle = this.toolSettings.strokeColor;
      ctx.lineWidth = this.toolSettings.strokeWidth;
      ctx.globalAlpha = this.toolSettings.opacity;

      if (this.shapeSubtype === 'rect') {
        if (this.toolSettings.fillColor !== 'transparent') {
          ctx.fillStyle = this.toolSettings.fillColor;
          ctx.fillRect(x, y, width, height);
        }
        ctx.strokeRect(x, y, width, height);
      } else if (this.shapeSubtype === 'circle') {
        ctx.beginPath();
        ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        if (this.toolSettings.fillColor !== 'transparent') {
          ctx.fillStyle = this.toolSettings.fillColor;
          ctx.fill();
        }
        ctx.stroke();
      } else if (this.shapeSubtype === 'line' || this.shapeSubtype === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(this.startPoint.x, this.startPoint.y);
        ctx.lineTo(this.currentPoint.x, this.currentPoint.y);
        ctx.stroke();

        if (this.shapeSubtype === 'arrow') {
          const angle = Math.atan2(this.currentPoint.y - this.startPoint.y, this.currentPoint.x - this.startPoint.x);
          const head = Math.max(10, this.toolSettings.strokeWidth * 4);
          ctx.beginPath();
          ctx.moveTo(this.currentPoint.x, this.currentPoint.y);
          ctx.lineTo(this.currentPoint.x - head * Math.cos(angle - Math.PI / 6), this.currentPoint.y - head * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(this.currentPoint.x, this.currentPoint.y);
          ctx.lineTo(this.currentPoint.x - head * Math.cos(angle + Math.PI / 6), this.currentPoint.y - head * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  clearLivePreview() {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
  }

  // Create or add a text annotation (PDFescape Architecture)
  createTextAnnotationAt(x, y, defaultText = '', opts = {}) {
    const fontSize = opts.fontSize || this.toolSettings.fontSize || 14;
    const fontFamily = opts.fontFamily || this.toolSettings.fontFamily || 'Helvetica';
    const fontColor = opts.fontColor || this.toolSettings.fontColor || '#000000';
    const fontWeight = opts.fontWeight || this.toolSettings.fontWeight || 'normal';
    const fontStyle = opts.fontStyle || this.toolSettings.fontStyle || 'normal';
    const backgroundColor = opts.backgroundColor !== undefined ? opts.backgroundColor : (this.toolSettings.backgroundColor || 'transparent');
    const width = opts.width || 180;
    const height = opts.height || Math.round(fontSize * 1.15);

    const ann = this.annotationManager.addAnnotation({
      pageIndex: this.activePageIndex,
      type: 'text',
      x: +(x.toFixed(2)),
      y: +(y.toFixed(2)),
      width: Math.round(width),
      height: Math.round(height),
      text: defaultText,
      fontSize,
      fontFamily,
      fontColor,
      fontWeight,
      fontStyle,
      backgroundColor,
      baselineY: opts.baselineY !== undefined ? opts.baselineY : null,
      isOriginalReplacement: !!opts.isOriginalReplacement,
      originalText: opts.originalText || null,
    });

    if (opts.appendSelection && opts.prevSelectedIds && opts.prevSelectedIds.length > 0) {
      const combinedIds = new Set([...opts.prevSelectedIds, ann.id]);
      this.annotationManager.selectedAnnotationIds = combinedIds;
      this.annotationManager.selectedAnnotationId = ann.id;
      this.annotationManager.notifySelection();
    } else {
      this.annotationManager.selectAnnotation(ann.id);
    }
    this.render();

    // Focus the text area immediately only when single-selecting
    const isMultiSelected = this.annotationManager.getSelectedAnnotations().length > 1;
    if (!isMultiSelected) {
      setTimeout(() => {
        if (this.annotationManager.getSelectedAnnotations().length > 1) return;
        const el = this.container.querySelector(`.pdf-text-element[data-id="${ann.id}"] .pdf-text-content`);
        if (el) {
          el.focus();
          if (defaultText) {
            el.select();
          }
          el.scrollLeft = 0;
          el.scrollTop = 0;
        }
      }, 20);
    }

    return ann;
  }

  // Synchronize persistent DOM text elements for the active page
  syncTextElements() {
    const pageWrapper = this.container.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
    if (!pageWrapper) return;
    const textLayer = pageWrapper.querySelector('.text-elements-layer');
    if (!textLayer) return;

    const pageAnnotations = this.annotationManager.getAnnotationsForPage(this.activePageIndex).filter(a => a.type === 'text');
    const currentDomIds = new Set();

    pageAnnotations.forEach(ann => {
      currentDomIds.add(ann.id);
      let el = textLayer.querySelector(`.pdf-text-element[data-id="${ann.id}"]`);

      if (!el) {
        el = document.createElement('div');
        el.className = 'pdf-text-element';
        el.dataset.id = ann.id;

        el.innerHTML = `
          <textarea class="pdf-text-content" rows="1" placeholder="Type text here..." spellcheck="false"></textarea>
          <div class="pdf-text-handle handle-e" data-handle="e"></div>
          <div class="pdf-text-handle handle-w" data-handle="w"></div>
          <div class="pdf-text-handle handle-s" data-handle="s"></div>
          <div class="pdf-text-handle handle-se" data-handle="se"></div>
        `;

        const textarea = el.querySelector('.pdf-text-content');
        textarea.value = ann.text || '';

        // Pointerdown on textarea: select annotation and handle Shift-selection / group drag / click-to-edit
        textarea.addEventListener('pointerdown', (e) => {
          // If in text/edit-pdf-text mode and user clicked/Shift-clicked an adjacent unclicked PDF text item
          if (this.activeTool === 'edit-pdf-text' || this.activeTool === 'text') {
            const pt = this.screenToPdf(e);
            const hitUnclicked = this.findTextItemAt(pt);
            if (hitUnclicked) {
              const distUnclicked = Math.hypot(pt.x - (hitUnclicked.x + hitUnclicked.width / 2), pt.y - (hitUnclicked.y + hitUnclicked.height / 2));
              const distCurrent = Math.hypot(pt.x - (ann.x + ann.width / 2), pt.y - (ann.y + ann.height / 2));
              if (distUnclicked < distCurrent) {
                e.preventDefault();
                e.stopPropagation();
                this.handlePointerDown(e);
                return;
              }
            }
          }

          if (e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pdf-text-content')) {
              try { document.activeElement.setSelectionRange(0, 0); } catch (err) {}
              document.activeElement.blur();
            }
            this.annotationManager.selectAnnotation(ann.id, true);
            return;
          }

          // If already actively focused and editing text inside textarea, let normal text selection / cursor placement happen!
          if (document.activeElement === textarea) {
            return;
          }

          // Textarea is NOT actively focused for typing:
          // Pointerdown can be either a click to edit OR a drag to move!
          e.stopPropagation();

          const isAlreadySelected = this.annotationManager.isSelected(ann.id);
          const wasMulti = this.annotationManager.getSelectedAnnotations().length > 1;

          const startX = e.clientX;
          const startY = e.clientY;
          let hasMoved = false;

          const onMoveCheck = (ev) => {
            const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
            if (dist > 3 && !hasMoved) {
              hasMoved = true;
              window.removeEventListener('pointermove', onMoveCheck);
              window.removeEventListener('pointerup', onUpCheck);

              if (!isAlreadySelected) {
                this.annotationManager.selectAnnotation(ann.id, false);
              }
              this.startDraggingTextElement(ev, ann, el, startX, startY);
            }
          };

          const onUpCheck = () => {
            window.removeEventListener('pointermove', onMoveCheck);
            window.removeEventListener('pointerup', onUpCheck);
            if (!hasMoved) {
              // Just a click without drag: select and focus for editing
              if (wasMulti && isAlreadySelected) {
                this.annotationManager.selectAnnotation(ann.id, false);
              } else if (!isAlreadySelected) {
                this.annotationManager.selectAnnotation(ann.id, false);
              }
              textarea.focus();
            }
          };

          window.addEventListener('pointermove', onMoveCheck);
          window.addEventListener('pointerup', onUpCheck);
        });

        // Auto-expand and update model on typing
        textarea.addEventListener('input', () => {
          ann.text = textarea.value;

          const fontSizePx = Math.max(6, +((ann.fontSize || 14) * this.zoom).toFixed(2));
          const lineH = Math.round(fontSizePx * 1.15);
          const lineCount = (textarea.value || '').split('\n').length;
          const desiredH = Math.max(10, Math.round(lineCount * lineH));

          el.style.height = `${desiredH}px`;
          textarea.style.height = `${desiredH}px`;
          ann.height = Math.round(desiredH / this.zoom);

          // Auto-expand width if text grows
          if (!this._measureCtx) {
            this._measureCtx = document.createElement('canvas').getContext('2d');
          }
          this._measureCtx.font = `${ann.fontWeight || 'normal'} ${fontSizePx}px ${ann.fontFamily || 'Helvetica'}`;
          const lines = (textarea.value || '').split('\n');
          let maxTextW = 0;
          for (const line of lines) {
            const w = this._measureCtx.measureText(line).width;
            if (w > maxTextW) maxTextW = w;
          }
          const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
          const maxAllowedWidth = Math.max(60, (pageSize ? pageSize.width : 600) - ann.x - 10);
          const neededW = Math.min(maxAllowedWidth, Math.max(30, Math.ceil((maxTextW + 8) / this.zoom)));

          if (neededW > ann.width) {
            ann.width = neededW;
            el.style.width = `${Math.round(neededW * this.zoom)}px`;
          }

          this.annotationManager.notifyChange('typing');
        });

        // Keydown: Escape key blurs and commits
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            textarea.blur();
            this.annotationManager.deselectAll();
          }
        });

        // Clean up empty box on blur (unless focus moved to toolbar/properties bar)
        textarea.addEventListener('blur', () => {
          if (!ann.text || ann.text.trim().length === 0) {
            setTimeout(() => {
              const active = document.activeElement;
              if (active && (active.closest('.properties-bar') || active.closest('.app-toolbar') || active.closest('.pdf-text-element'))) {
                return;
              }
              if (!ann.text || ann.text.trim().length === 0) {
                this.annotationManager.deleteAnnotation(ann.id);
              }
            }, 180);
          } else {
            this.annotationManager.pushHistory('Edit Text');
          }
        });

        // Resize handles
        el.querySelectorAll('.pdf-text-handle').forEach(h => {
          h.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.annotationManager.selectAnnotation(ann.id, false);
            this.startResizingTextElement(e, ann, el, h.dataset.handle);
          });
        });

        // Clicking the border of element (supports Shift-selection and multi-drag)
        el.addEventListener('pointerdown', (e) => {
          if (e.target === el) {
            e.stopPropagation();
            if (e.shiftKey) {
              if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('pdf-text-content')) {
                try { document.activeElement.setSelectionRange(0, 0); } catch (err) {}
                document.activeElement.blur();
              }
              this.annotationManager.selectAnnotation(ann.id, true);
              return;
            }
            if (!this.annotationManager.isSelected(ann.id)) {
              this.annotationManager.selectAnnotation(ann.id, false);
            }
            this.startDraggingTextElement(e, ann, el);
          }
        });

        textLayer.appendChild(el);
      }

      // Update position, scale, and styling
      el.style.left = `${+(ann.x * this.zoom).toFixed(2)}px`;
      el.style.top = `${+(ann.y * this.zoom).toFixed(2)}px`;
      if (ann.width) el.style.width = `${Math.round(ann.width * this.zoom)}px`;

      const fontSizePx = Math.max(6, +((ann.fontSize || 14) * this.zoom).toFixed(2));
      const lineH = Math.round(fontSizePx * 1.15);
      const lineCount = (ann.text || '').split('\n').length;
      const desiredH = Math.max(10, Math.round(lineCount * lineH));
      el.style.height = `${desiredH}px`;

      const hasBg = (ann.backgroundColor && ann.backgroundColor !== 'transparent');
      el.style.backgroundColor = hasBg ? ann.backgroundColor : 'transparent';

      const textarea = el.querySelector('.pdf-text-content');
      if (textarea) {
        if (document.activeElement !== textarea && textarea.value !== (ann.text || '')) {
          textarea.value = ann.text || '';
        }

        textarea.style.fontSize = `${fontSizePx}px`;
        textarea.style.fontFamily = ann.fontFamily || 'Helvetica';
        textarea.style.color = ann.fontColor || '#000000';
        textarea.style.fontWeight = ann.fontWeight || 'normal';
        textarea.style.fontStyle = ann.fontStyle || 'normal';
        textarea.style.backgroundColor = 'transparent';
        textarea.style.lineHeight = '1.15';
        textarea.style.overflow = 'hidden';
        textarea.style.height = `${desiredH}px`;
      }

      const isSelected = this.annotationManager.isSelected(ann.id);
      el.classList.toggle('selected', isSelected);
    });

    // Remove obsolete DOM elements
    Array.from(textLayer.querySelectorAll('.pdf-text-element')).forEach(el => {
      if (!currentDomIds.has(el.dataset.id)) {
        el.remove();
      }
    });
  }

  // Smooth dragging for DOM text element (handles both single and group dragging)
  startDraggingTextElement(e, ann, el, startDownX = null, startDownY = null) {
    const selectedAnns = this.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
    const itemsToDrag = (selectedAnns.length > 1 && selectedAnns.some(a => a.id === ann.id))
      ? selectedAnns
      : [ann];

    const startX = startDownX !== null ? startDownX : e.clientX;
    const startY = startDownY !== null ? startDownY : e.clientY;
    const initialPositions = itemsToDrag.map(a => ({
      ann: a,
      initX: a.x,
      initY: a.y,
      initBaselineY: a.baselineY,
      el: this.container ? this.container.querySelector(`.pdf-text-element[data-id="${a.id}"]`) : null
    }));

    const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
    const maxX = (pageSize ? pageSize.width : 1000) - 20;
    const maxY = (pageSize ? pageSize.height : 1000) - 10;

    const onPointerMove = (ev) => {
      const dx = (ev.clientX - startX) / this.zoom;
      const dy = (ev.clientY - startY) / this.zoom;

      initialPositions.forEach(item => {
        item.ann.x = Math.max(0, Math.min(maxX, Math.round(item.initX + dx)));
        item.ann.y = Math.max(0, Math.min(maxY, Math.round(item.initY + dy)));
        if (item.ann.baselineY !== undefined && item.ann.baselineY !== null && item.initBaselineY !== undefined && item.initBaselineY !== null) {
          item.ann.baselineY = Math.round(item.initBaselineY + dy);
        }
        if (item.el) {
          item.el.style.left = `${Math.round(item.ann.x * this.zoom)}px`;
          item.el.style.top = `${Math.round(item.ann.y * this.zoom)}px`;
        }
      });
      this.updateSelectionBox();
    };

    // If e is already a move event (e.g. from threshold check), apply initial move immediately
    if (startDownX !== null && startDownY !== null) {
      onPointerMove(e);
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      this.annotationManager.pushHistory(`Move ${itemsToDrag.length} Text Element${itemsToDrag.length > 1 ? 's' : ''}`);
      this.annotationManager.notifyChange('update');
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  // Smooth resizing for DOM text element
  startResizingTextElement(e, ann, el, handle) {
    const startX = e.clientX;
    const startY = e.clientY;
    const initW = ann.width || el.offsetWidth / this.zoom;
    const initH = ann.height || el.offsetHeight / this.zoom;
    const initX = ann.x;
    const initY = ann.y;

    const onPointerMove = (ev) => {
      const dx = (ev.clientX - startX) / this.zoom;
      const dy = (ev.clientY - startY) / this.zoom;

      if (handle.includes('e')) {
        ann.width = Math.max(60, Math.round(initW + dx));
        el.style.width = `${Math.round(ann.width * this.zoom)}px`;
      }
      if (handle.includes('s')) {
        ann.height = Math.max(20, Math.round(initH + dy));
        const textarea = el.querySelector('.pdf-text-content');
        if (textarea) textarea.style.minHeight = `${Math.round(ann.height * this.zoom)}px`;
      }
      if (handle.includes('w')) {
        const potentialW = Math.max(60, Math.round(initW - dx));
        ann.width = potentialW;
        ann.x = Math.round(initX + (initW - potentialW));
        el.style.width = `${Math.round(ann.width * this.zoom)}px`;
        el.style.left = `${Math.round(ann.x * this.zoom)}px`;
      }
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      this.annotationManager.pushHistory('Resize Text');
      this.annotationManager.notifyChange('update');
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  // Legacy compatibility helpers
  spawnInlineTextEditor(x, y, existingText = '', annotationId = null) {
    if (annotationId) {
      const ann = this.annotationManager.getAnnotation(annotationId);
      if (ann) {
        this.annotationManager.selectAnnotation(annotationId);
        const el = this.container.querySelector(`.pdf-text-element[data-id="${annotationId}"] .pdf-text-content`);
        if (el) {
          el.focus();
          if (existingText) el.select();
        }
        return ann;
      }
    }
    return this.createTextAnnotationAt(x, y, existingText);
  }

  commitTextEditor() {
    // Persistent text elements auto-sync on input and blur
  }

  // Render annotations on the overlay canvas
  render() {
    const pageWrapper = this.container.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
    if (!pageWrapper) return;

    const layer = pageWrapper.querySelector('.annotation-layer');
    if (!layer) return;

    const canvas = layer.querySelector('.annotation-canvas:not(.preview)');
    const preview = layer.querySelector('.annotation-canvas.preview');
    if (!canvas) return;

    const pageSize = this.pdfEngine.getPageSize(this.activePageIndex);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(pageSize.width * this.zoom);
    const h = Math.floor(pageSize.height * this.zoom);

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    if (preview) {
      preview.width = Math.floor(w * dpr);
      preview.height = Math.floor(h * dpr);
      preview.style.width = `${w}px`;
      preview.style.height = `${h}px`;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr * this.zoom, dpr * this.zoom);

    const annotations = this.annotationManager.getAnnotationsForPage(this.activePageIndex);

    // 1. Draw Freehand and Highlighters
    annotations.forEach(ann => {
      if ((ann.type === 'freehand' || ann.type === 'highlighter') && ann.points && ann.points.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ann.strokeColor || '#000000';
        ctx.lineWidth = ann.strokeWidth || 3;
        ctx.globalAlpha = ann.type === 'highlighter' ? (ann.opacity || 0.45) : (ann.opacity || 1.0);

        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      }
    });

    // 2. Draw Rectangles, Shapes, Whiteouts, Blackouts, Images, Stamps
    annotations.forEach(ann => {
      // (Note: Text annotations are rendered in the persistent DOM layer via syncTextElements)

      // RECTANGLE
      if (ann.type === 'rect') {
        ctx.save();
        ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1.0;
        if (ann.fillColor && ann.fillColor !== 'transparent') {
          ctx.fillStyle = ann.fillColor;
          ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
        }
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
        ctx.restore();
      }

      // CIRCLE / ELLIPSE
      else if (ann.type === 'circle') {
        ctx.save();
        ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1.0;
        ctx.beginPath();
        ctx.ellipse(ann.x + ann.width / 2, ann.y + ann.height / 2, ann.width / 2, ann.height / 2, 0, 0, Math.PI * 2);
        if (ann.fillColor && ann.fillColor !== 'transparent') {
          ctx.fillStyle = ann.fillColor;
          ctx.fill();
        }
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.stroke();
        ctx.restore();
      }

      // LINE
      else if (ann.type === 'line') {
        ctx.save();
        ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1.0;
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 2;
        ctx.beginPath();
        ctx.moveTo(ann.x, ann.y);
        ctx.lineTo(ann.x + ann.width, ann.y + ann.height);
        ctx.stroke();
        ctx.restore();
      }

      // ARROW
      else if (ann.type === 'arrow') {
        ctx.save();
        ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1.0;
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 2;
        const startX = ann.x;
        const startY = ann.y;
        const endX = ann.x + ann.width;
        const endY = ann.y + ann.height;

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        const angle = Math.atan2(endY - startY, endX - startX);
        const head = Math.max(10, (ann.strokeWidth || 2) * 4);
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
        ctx.restore();
      }

      // WHITEOUT
      else if (ann.type === 'whiteout') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      }

      // BLACKOUT
      else if (ann.type === 'blackout') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      }

      // CHECKMARK & CROSS
      else if (ann.type === 'checkmark') {
        ctx.save();
        ctx.strokeStyle = ann.strokeColor || '#10b981';
        ctx.lineWidth = ann.strokeWidth || 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const w = ann.width;
        const h = ann.height;
        ctx.beginPath();
        ctx.moveTo(ann.x + w * 0.15, ann.y + h * 0.55);
        ctx.lineTo(ann.x + w * 0.42, ann.y + h * 0.85);
        ctx.lineTo(ann.x + w * 0.88, ann.y + h * 0.18);
        ctx.stroke();
        ctx.restore();
      } else if (ann.type === 'cross') {
        ctx.save();
        ctx.strokeStyle = ann.strokeColor || '#ef4444';
        ctx.lineWidth = ann.strokeWidth || 2.5;
        ctx.lineCap = 'round';
        const w = ann.width;
        const h = ann.height;
        ctx.beginPath();
        ctx.moveTo(ann.x + w * 0.2, ann.y + h * 0.2);
        ctx.lineTo(ann.x + w * 0.8, ann.y + h * 0.8);
        ctx.moveTo(ann.x + w * 0.8, ann.y + h * 0.2);
        ctx.lineTo(ann.x + w * 0.2, ann.y + h * 0.8);
        ctx.stroke();
        ctx.restore();
      }

      // IMAGE & SIGNATURE
      else if (ann.type === 'image' || ann.type === 'signature') {
        if (ann.imgDataUrl) {
          if (!ann._cachedImg) {
            const img = new Image();
            img.src = ann.imgDataUrl;
            img.onload = () => {
              ann._cachedImg = img;
              this.render();
            };
          } else {
            ctx.save();
            ctx.globalAlpha = ann.opacity !== undefined ? ann.opacity : 1.0;
            ctx.drawImage(ann._cachedImg, ann.x, ann.y, ann.width, ann.height);
            ctx.restore();
          }
        }
      }
    });

    ctx.restore();

    // Synchronize persistent DOM text elements (PDFescape Architecture)
    this.syncTextElements();
  }

  // Update selection bounding box & handles
  updateSelectionBox() {
    const pageWrapper = this.container.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
    if (!pageWrapper) return;

    const layer = pageWrapper.querySelector('.annotation-layer');
    if (!layer) return;

    let box = layer.querySelector('.selection-box');
    const selected = this.annotationManager.getSelectedAnnotation();

    // Text annotations have their own DOM border, drag bar, and handles
    if (!selected || selected.pageIndex !== this.activePageIndex || selected.type === 'text') {
      if (box) box.remove();
      return;
    }

    if (!box) {
      box = document.createElement('div');
      box.className = 'selection-box';

      // 8 Resize handles
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => {
        const handle = document.createElement('div');
        handle.className = `selection-handle handle-${h}`;
        handle.dataset.handle = h;
        box.appendChild(handle);
      });

      // Selection actions bar (Duplicate, Delete)
      const actions = document.createElement('div');
      actions.className = 'selection-actions-bar';
      actions.innerHTML = `
        <button class="selection-action-btn" data-action="duplicate" title="Duplicate (Ctrl+D)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="selection-action-btn btn-delete" data-action="delete" title="Delete (Del)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      `;

      actions.querySelector('[data-action="duplicate"]').addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.annotationManager.duplicateAnnotation(selected.id);
      });
      actions.querySelector('[data-action="delete"]').addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.annotationManager.deleteAnnotation(selected.id);
      });

      box.appendChild(actions);
      layer.appendChild(box);
    }

    // Position selection box
    box.style.left = `${selected.x * this.zoom}px`;
    box.style.top = `${selected.y * this.zoom}px`;
    box.style.width = `${selected.width * this.zoom}px`;
    box.style.height = `${selected.height * this.zoom}px`;
  }
}

window.CanvasController = CanvasController;
