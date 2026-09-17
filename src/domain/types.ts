export interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Annotation {
  id: string;
  bbox: BBox;
  label: string;
  /**
   * The original annotation this box was accepted from, while the reference
   * layer is loaded. It keeps the two in step: deleting the box hands the
   * original back to the picking pool, and undo restores the link.
   */
  referenceId?: string | null;
  /**
   * REC "level" of the expression this box belongs to (`L1`/`L2`/`L3` in the
   * shipped datasets). It comes from a JSONL line, so every box of the same
   * expression shares it; TXT documents have none.
   */
  level?: string | null;
  reservedField: "0" | null;
}

/**
 * One box of the original-annotation file the annotator picks from. It is not
 * part of the document: it is only written to disk while its own file is edited.
 */
export interface ReferenceBox {
  id: string;
  bbox: BBox;
  label: string;
}

export interface ImageInfo {
  name: string;
  width: number;
  height: number;
  url: string;
}

export interface AnnotationDocument {
  image: ImageInfo | null;
  labelFileName: string | null;
  annotations: Annotation[];
}

export interface ImageBounds {
  width: number;
  height: number;
}

export interface ParseIssue {
  line: number;
  reason: string;
  source: string;
}

export interface ParseResult {
  annotations: Annotation[];
  issues: ParseIssue[];
}
