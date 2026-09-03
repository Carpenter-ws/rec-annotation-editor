import type { Annotation, AnnotationDocument } from "./types";

const coordinate = (value: number) => value.toFixed(2);

export function serializeAnnotationsTxt(
  annotations: readonly Annotation[],
): string {
  if (annotations.length === 0) return "";

  return (
    annotations
      .map(
        ({ bbox, label }) =>
          [bbox.x1, bbox.y1, bbox.x2, bbox.y2].map(coordinate).join(" ") +
          " " +
          label.trim() +
          " 0",
      )
      .join("\n") + "\n"
  );
}

export function serializeDocumentJson(document: AnnotationDocument): string {
  return (
    JSON.stringify(
      {
        image: document.image?.name ?? null,
        width: document.image?.width ?? null,
        height: document.image?.height ?? null,
        annotations: document.annotations.map(
          ({ id, bbox, label, reservedField }) => ({
            id,
            bbox: [bbox.x1, bbox.y1, bbox.x2, bbox.y2],
            label,
            reservedField,
          }),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}
