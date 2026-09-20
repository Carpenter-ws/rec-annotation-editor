/**
 * Review state of one image. An image nobody has looked at yet is `pending`,
 * which is exactly what the editor opens on, so a session always continues
 * where the review pass stopped.
 */
export const REVIEW_STATUSES = ["approved", "pending", "rejected"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Wording used by the toolbar and the file manager. */
export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  approved: "审核通过",
  pending: "待审核",
  rejected: "打回",
};

/** Guards a status that came from the API or a hand-edited file. */
export function isReviewStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

/** Status of one item, defaulting to `pending` for anything unreadable. */
export function reviewStatusOf(item: {
  review?: ReviewStatus | null;
}): ReviewStatus {
  return isReviewStatus(item.review) ? item.review : "pending";
}

export interface ReviewableItem {
  review?: ReviewStatus | null;
  image?: string | null;
}

/**
 * The image a dataset should open on: the first one still waiting for review.
 * Items without an image are skipped (there is nothing to look at), and a
 * dataset that has been fully reviewed falls back to its first openable item.
 */
export function firstPendingItem<T extends ReviewableItem>(
  items: readonly T[],
): T | null {
  const openable = items.filter((item) => item.image);
  const pending = openable.find(
    (item) => reviewStatusOf(item) === "pending",
  );
  return pending ?? openable[0] ?? null;
}

/**
 * The image a decision leads to: the next one still waiting for review, so a
 * pass walks forward on its own. When nothing after it is pending any more the
 * next openable image is taken instead, which keeps the paging predictable at
 * the end of a pass. `null` means there is nothing left to move to.
 */
export function nextItemAfterReview<T extends ReviewableItem & { stem: string }>(
  items: readonly T[],
  fromStem: string,
): T | null {
  const openable = items.filter((item) => item.image);
  const index = openable.findIndex((item) => item.stem === fromStem);
  if (index < 0) return null;
  const rest = openable.slice(index + 1);
  return (
    rest.find((item) => reviewStatusOf(item) === "pending") ?? rest[0] ?? null
  );
}

/** How many images sit in each state, for the dataset cards. */
export function reviewCounts(
  items: readonly { review?: ReviewStatus | null }[],
): Record<ReviewStatus, number> {
  const counts: Record<ReviewStatus, number> = {
    approved: 0,
    pending: 0,
    rejected: 0,
  };
  for (const item of items) counts[reviewStatusOf(item)] += 1;
  return counts;
}

/** Order the three states are offered in, as asked for by the workflow. */
export const REVIEW_ORDER: readonly ReviewStatus[] = [
  "approved",
  "pending",
  "rejected",
];
