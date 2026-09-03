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
  reservedField: "0" | null;
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
