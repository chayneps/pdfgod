/**
 * Annotation Manager
 * Manages document annotations, selection, history (undo/redo), and state changes.
 */

class AnnotationManager {
  constructor() {
    // Array of annotations
    this.annotations = [];
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds = new Set();

    // Undo / Redo history stacks
    this.historyStack = [];
    this.redoStack = [];
    this.maxHistory = 50;
    this.pdfEngine = null;

    // Listeners for state change
    this.changeListeners = [];
    this.selectionListeners = [];
    this._byId = null;
  }

  _ensureIndex() {
    if (!this._byId || this._byIdRef !== this.annotations || this._byId.size !== this.annotations.length) {
      this._byId = new Map();
      this._byIdRef = this.annotations;
      for (let i = 0; i < this.annotations.length; i++) {
        const a = this.annotations[i];
        if (a && a.id) this._byId.set(a.id, a);
      }
    }
    return this._byId;
  }

  _invalidateIndex() {
    this._byId = null;
  }

  // Generate unique ID
  generateId() {
    return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  // Subscribe to changes
  onChange(callback) {
    this.changeListeners.push(callback);
  }

  onSelectionChange(callback) {
    this.selectionListeners.push(callback);
  }

  notifyChange(actionType = 'update') {
    this._invalidateIndex();
    this.changeListeners.forEach(fn => fn(this.annotations, actionType));
  }

  notifySelection() {
    const selected = this.getSelectedAnnotation();
    const allSelected = this.getSelectedAnnotations();
    this.selectionListeners.forEach(fn => fn(selected, allSelected));
  }

  // Record history snapshot for undo
  pushHistory(description = 'action', pdfBytesOverride = null, skipPdfSnapshot = false) {
    // Fast clone annotations
    const snapshot = this.annotations.map(a => {
      const copy = Object.assign({}, a);
      if (copy.points) copy.points = copy.points.slice();
      return copy;
    });

    const pdfBytesSnapshot = skipPdfSnapshot
      ? null
      : (pdfBytesOverride
        ? new Uint8Array(pdfBytesOverride)
        : (this.pdfEngine && (this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes)
          ? new Uint8Array(this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes)
          : null));

    this.historyStack.push({
      description,
      snapshot,
      pdfBytesSnapshot,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    }

    // Clear redo on new action
    this.redoStack = [];
  }

  canUndo() {
    return this.historyStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  async undo() {
    if (!this.canUndo()) return;

    // Push current state to redo
    const currentSnapshot = JSON.parse(JSON.stringify(this.annotations));
    const currentPdfBytes = (this.pdfEngine && (this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes))
      ? new Uint8Array(this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes)
      : null;

    this.redoStack.push({
      snapshot: currentSnapshot,
      pdfBytesSnapshot: currentPdfBytes,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    const previous = this.historyStack.pop();
    this.annotations = previous.snapshot;
    this.selectedAnnotationId = previous.selectedId;
    this.selectedAnnotationIds = new Set(previous.selectedIds || (previous.selectedId ? [previous.selectedId] : []));

    if (previous.pdfBytesSnapshot && this.pdfEngine && this.pdfEngine.setPdfBytes) {
      await this.pdfEngine.setPdfBytes(previous.pdfBytesSnapshot);
      this.notifyChange('undo-pdf');
    } else {
      this.notifyChange('undo');
    }
    this.notifySelection();
  }

  async redo() {
    if (!this.canRedo()) return;

    const currentSnapshot = JSON.parse(JSON.stringify(this.annotations));
    const currentPdfBytes = (this.pdfEngine && (this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes))
      ? new Uint8Array(this.pdfEngine.activePdfBytes || this.pdfEngine.originalPdfBytes)
      : null;

    this.historyStack.push({
      snapshot: currentSnapshot,
      pdfBytesSnapshot: currentPdfBytes,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    const next = this.redoStack.pop();
    this.annotations = next.snapshot;
    this.selectedAnnotationId = next.selectedId;
    this.selectedAnnotationIds = new Set(next.selectedIds || (next.selectedId ? [next.selectedId] : []));

    if (next.pdfBytesSnapshot && this.pdfEngine && this.pdfEngine.setPdfBytes) {
      await this.pdfEngine.setPdfBytes(next.pdfBytesSnapshot);
      this.notifyChange('redo-pdf');
    } else {
      this.notifyChange('redo');
    }
    this.notifySelection();
  }

  // Add Annotation
  addAnnotation(annotation) {
    const pdfBytesOverride = annotation.preRedactionPdfBytes || null;
    this.pushHistory(`Add ${annotation.type}`, pdfBytesOverride);
    if (pdfBytesOverride) {
      Object.defineProperty(annotation, '_preRedactionPdfBytes', {
        value: pdfBytesOverride,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (!annotation.id) {
      annotation.id = this.generateId();
    }
    this.annotations.push(annotation);
    this.selectedAnnotationId = annotation.id;
    this.selectedAnnotationIds = new Set([annotation.id]);

    this.notifyChange('add');
    this.notifySelection();
    return annotation;
  }

  // Add multiple annotations atomically (e.g. for Paste)
  addAnnotations(annotationList, description = null, pdfBytesOverride = null) {
    if (!annotationList || annotationList.length === 0) return [];

    const desc = description || `Add ${annotationList.length} element${annotationList.length > 1 ? 's' : ''}`;
    this.pushHistory(desc, pdfBytesOverride);

    annotationList.forEach(a => {
      if (!a.id) a.id = this.generateId();
      if (pdfBytesOverride) {
        Object.defineProperty(a, '_preRedactionPdfBytes', {
          value: pdfBytesOverride,
          writable: true,
          enumerable: false,
          configurable: true,
        });
        a.preRedactionPdfBytes = pdfBytesOverride;
      }
      this.annotations.push(a);
    });

    this.selectedAnnotationIds = new Set(annotationList.map(a => a.id));
    this.selectedAnnotationId = annotationList[0].id;

    this.notifyChange('add');
    this.notifySelection();
    return annotationList;
  }

  // Update Annotation
  updateAnnotation(id, updates, recordHistory = true) {
    const item = this.getAnnotation(id);
    if (!item) return;

    if (recordHistory) {
      this.pushHistory(`Update ${item.type}`);
    }

    Object.assign(item, updates);
    this.notifyChange('update');
  }

  // Delete Annotation
  deleteAnnotation(id) {
    const item = this.getAnnotation(id);
    if (!item) return;

    this.pushHistory(`Delete ${item.type}`);
    this.annotations = this.annotations.filter(a => a.id !== id);
    this.selectedAnnotationIds.delete(id);

    if (this.selectedAnnotationId === id) {
      this.selectedAnnotationId = this.selectedAnnotationIds.size > 0
        ? Array.from(this.selectedAnnotationIds)[0]
        : null;
      this.notifySelection();
    }

    this.notifyChange('delete');
  }

  // Delete Multiple Annotations Atomically
  deleteAnnotations(ids) {
    if (!ids || ids.length === 0) return;
    const idSet = new Set(ids);
    const toRemove = this.annotations.filter(a => idSet.has(a.id));
    if (toRemove.length === 0) return;

    this.pushHistory(`Delete ${toRemove.length} element(s)`);
    this.annotations = this.annotations.filter(a => !idSet.has(a.id));
    for (const id of idSet) {
      this.selectedAnnotationIds.delete(id);
    }

    if (idSet.has(this.selectedAnnotationId)) {
      this.selectedAnnotationId = this.selectedAnnotationIds.size > 0
        ? Array.from(this.selectedAnnotationIds)[0]
        : null;
    }

    this.notifyChange('delete');
    this.notifySelection();
  }

  // Get by ID (O(1) indexed lookup with fallback)
  getAnnotation(id) {
    if (!id) return null;
    let item = this._ensureIndex().get(id);
    if (!item) {
      this._invalidateIndex();
      item = this._ensureIndex().get(id);
    }
    return item || null;
  }

  getAnnotationById(id) {
    return this.getAnnotation(id);
  }

  // Get Primary Selected
  getSelectedAnnotation() {
    if (!this.selectedAnnotationId) return null;
    return this.getAnnotation(this.selectedAnnotationId);
  }

  // Get All Selected Annotations (O(K) lookup)
  getSelectedAnnotations() {
    const idx = this._ensureIndex();
    if (this.selectedAnnotationIds.size === 0) {
      if (this.selectedAnnotationId) {
        const item = idx.get(this.selectedAnnotationId);
        return item ? [item] : [];
      }
      return [];
    }
    const result = [];
    for (const id of this.selectedAnnotationIds) {
      const item = idx.get(id);
      if (item) result.push(item);
    }
    return result;
  }

  // Check if an annotation is selected
  isSelected(id) {
    if (!id) return false;
    return this.selectedAnnotationIds.has(id) || this.selectedAnnotationId === id;
  }

  // Select Annotation (supports multi-selection with isMulti)
  selectAnnotation(id, isMulti = false) {
    if (!id) return;
    if (isMulti) {
      if (this.selectedAnnotationIds.has(id)) {
        this.selectedAnnotationIds.delete(id);
        if (this.selectedAnnotationId === id) {
          this.selectedAnnotationId = this.selectedAnnotationIds.size > 0
            ? Array.from(this.selectedAnnotationIds)[0]
            : null;
        }
      } else {
        this.selectedAnnotationIds.add(id);
        this.selectedAnnotationId = id;
      }
    } else {
      this.selectedAnnotationIds = new Set([id]);
      this.selectedAnnotationId = id;
    }
    this.notifySelection();
  }

  deselectAll() {
    if (this.selectedAnnotationId === null && this.selectedAnnotationIds.size === 0) return;
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds.clear();
    this.notifySelection();
  }

  // Get Annotations for a Page
  getAnnotationsForPage(pageIndex) {
    return this.annotations.filter(a => a.pageIndex === pageIndex);
  }

  getPageAnnotations(pageIndex) {
    return this.getAnnotationsForPage(pageIndex);
  }

  // Duplicate annotation
  duplicateAnnotation(id) {
    const item = this.getAnnotation(id);
    if (!item) return;

    const clone = JSON.parse(JSON.stringify(item));
    clone.id = this.generateId();
    clone.x += 15;
    clone.y += 15;

    this.addAnnotation(clone);
    return clone;
  }

  // Bring to front
  bringToFront(id) {
    const index = this.annotations.findIndex(a => a.id === id);
    if (index === -1 || index === this.annotations.length - 1) return;

    this.pushHistory('Bring to front');
    const [item] = this.annotations.splice(index, 1);
    this.annotations.push(item);
    this.notifyChange('reorder');
  }

  // Send to back
  sendToBack(id) {
    const index = this.annotations.findIndex(a => a.id === id);
    if (index <= 0) return;

    this.pushHistory('Send to back');
    const [item] = this.annotations.splice(index, 1);
    this.annotations.unshift(item);
    this.notifyChange('reorder');
  }

  // Update page index after page deletions or insertions
  handlePageRemoved(removedPageIndex) {
    this.pushHistory('Page removed');
    // Remove annotations on the deleted page
    this.annotations = this.annotations.filter(a => a.pageIndex !== removedPageIndex);
    // Decrement pageIndex for subsequent pages
    this.annotations.forEach(a => {
      if (a.pageIndex > removedPageIndex) {
        a.pageIndex -= 1;
      }
    });
    this.selectedAnnotationId = null;
    this.notifyChange('page-modified');
    this.notifySelection();
  }

  handlePageInserted(insertedAtIndex) {
    this.handlePagesInserted(insertedAtIndex, 1);
  }

  handlePagesInserted(insertedAtIndex, count = 1) {
    if (count <= 0) return;
    this.pushHistory(`${count} page(s) inserted`);
    this.annotations.forEach(a => {
      if (a.pageIndex >= insertedAtIndex) {
        a.pageIndex += count;
      }
    });
    this.notifyChange('page-modified');
  }

  // Handle page reordering
  handlePageMoved(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    this.pushHistory(`Page ${fromIndex + 1} moved to ${toIndex + 1}`);

    this.annotations.forEach(a => {
      if (a.pageIndex === fromIndex) {
        a.pageIndex = toIndex;
      } else if (fromIndex < toIndex) {
        if (a.pageIndex > fromIndex && a.pageIndex <= toIndex) {
          a.pageIndex -= 1;
        }
      } else if (fromIndex > toIndex) {
        if (a.pageIndex >= toIndex && a.pageIndex < fromIndex) {
          a.pageIndex += 1;
        }
      }
    });

    this.notifyChange('page-modified');
  }

  // Handle multi-page reordering with index map
  handlePagesReordered(oldIndexToNewIndex) {
    if (!oldIndexToNewIndex || !(oldIndexToNewIndex instanceof Map)) return;
    this.pushHistory(`Pages reordered`);

    this.annotations.forEach(a => {
      if (oldIndexToNewIndex.has(a.pageIndex)) {
        a.pageIndex = oldIndexToNewIndex.get(a.pageIndex);
      }
    });

    this.notifyChange('page-modified');
  }

  // Rotate all annotations on a page by given degrees (typically 90 CW)
  rotatePageAnnotations(pageIndex, degrees = 90, oldW, oldH) {
    const steps = (((degrees % 360) + 360) % 360) / 90;
    if (steps === 0) return;

    let curW = oldW;
    let curH = oldH;

    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.annotations.length; i++) {
        const ann = this.annotations[i];
        if (ann.pageIndex !== pageIndex) continue;

        if (ann.type === 'text') {
          const nx = +(curH - ann.y).toFixed(2);
          const ny = +(ann.x).toFixed(2);
          ann.x = nx;
          ann.y = ny;
          ann.rotation = (((ann.rotation || 0) + 90) % 360);
          if (ann.origX !== undefined && ann.origY !== undefined) {
            const nox = +(curH - ann.origY).toFixed(2);
            const noy = +(ann.origX).toFixed(2);
            ann.origX = nox;
            ann.origY = noy;
          }
          if (ann.baselineY !== undefined && ann.baselineY !== null) {
            ann.baselineY = null; // baseline offset is relative to local unrotated box
          }
        } else if (ann.type === 'line' || ann.type === 'arrow') {
          const x1 = ann.x;
          const y1 = ann.y;
          const x2 = ann.x + (ann.width || 0);
          const y2 = ann.y + (ann.height || 0);
          const nx1 = +(curH - y1).toFixed(2);
          const ny1 = +(x1).toFixed(2);
          const nx2 = +(curH - y2).toFixed(2);
          const ny2 = +(x2).toFixed(2);
          ann.x = nx1;
          ann.y = ny1;
          ann.width = +((nx2 - nx1).toFixed(2));
          ann.height = +((ny2 - ny1).toFixed(2));
          if (ann.origX !== undefined && ann.origY !== undefined) {
            const nox = +(curH - ann.origY).toFixed(2);
            const noy = +(ann.origX).toFixed(2);
            ann.origX = nox;
            ann.origY = noy;
          }
        } else if (ann.type === 'freehand' || ann.type === 'highlighter') {
          if (Array.isArray(ann.points)) {
            ann.points = ann.points.map(p => ({
              x: +(curH - p.y).toFixed(2),
              y: +(p.x).toFixed(2)
            }));
          }
          const nx = +(curH - (ann.y + (ann.height || 0))).toFixed(2);
          const ny = +(ann.x).toFixed(2);
          const nw = ann.height || 0;
          const nh = ann.width || 0;
          ann.x = nx;
          ann.y = ny;
          ann.width = nw;
          ann.height = nh;
        } else {
          // rect, circle, whiteout, blackout, checkmark, cross, image, signature
          const nx = +(curH - (ann.y + (ann.height || 0))).toFixed(2);
          const ny = +(ann.x).toFixed(2);
          const nw = ann.height || 0;
          const nh = ann.width || 0;
          ann.x = nx;
          ann.y = ny;
          ann.width = nw;
          ann.height = nh;
          ann.rotation = (((ann.rotation || 0) + 90) % 360);
        }
      }

      // Swap curW and curH for subsequent steps
      const temp = curW;
      curW = curH;
      curH = temp;
    }

    this.notifyChange('page-modified');
  }

  // Clear all
  clear() {
    this.annotations = [];
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds.clear();
    this.historyStack = [];
    this.redoStack = [];
    this.notifyChange('clear');
    this.notifySelection();
  }
}

window.AnnotationManager = AnnotationManager;
