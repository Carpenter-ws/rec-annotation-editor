import type { Annotation, AnnotationDocument } from "./types";

const coordinateFormatter = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const coordinate = (value: number) => coordinateFormatter.format(value);

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
          ({ id, bbox, label, level, reservedField }) => ({
            id,
            bbox: [bbox.x1, bbox.y1, bbox.x2, bbox.y2],
            label,
            level: level ?? null,
            reservedField,
          }),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}
