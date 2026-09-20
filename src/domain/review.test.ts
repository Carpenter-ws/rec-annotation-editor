import { describe, expect, it } from "vitest";
import {
  firstPendingItem,
  isReviewStatus,
  nextItemAfterReview,
  reviewCounts,
  reviewStatusOf,
} from "./review";

const items = [
  { stem: "a", image: "a.jpg", review: "approved" as const },
  { stem: "b", image: "b.jpg", review: "rejected" as const },
  { stem: "c", image: "c.jpg", review: "pending" as const },
  { stem: "d", image: "d.jpg" },
];

describe("reviewStatusOf", () => {
  it("treats a missing or unknown status as pending", () => {
    expect(reviewStatusOf({ review: "approved" })).toBe("approved");
    expect(reviewStatusOf({ review: "rejected" })).toBe("rejected");
    expect(reviewStatusOf({})).toBe("pending");
    expect(reviewStatusOf({ review: null })).toBe("pending");
  });

  it("guards values coming from a file or the API", () => {
    expect(isReviewStatus("pending")).toBe(true);
    expect(isReviewStatus("approved")).toBe(true);
    expect(isReviewStatus("maybe")).toBe(false);
    expect(isReviewStatus(undefined)).toBe(false);
  });
});

describe("firstPendingItem", () => {
  it("opens on the first image still waiting for review", () => {
    expect(firstPendingItem(items)?.stem).toBe("c");
  });

  it("never opens an item that has no image", () => {
    expect(
      firstPendingItem([
        { stem: "no-image", image: null },
        { stem: "ready", image: "ready.jpg" },
      ])?.stem,
    ).toBe("ready");
  });

  it("falls back to the first openable item once everything was decided", () => {
    expect(
      firstPendingItem([
        { stem: "a", image: "a.jpg", review: "approved" as const },
        { stem: "b", image: "b.jpg", review: "rejected" as const },
      ])?.stem,
    ).toBe("a");
  });

  it("returns nothing for a dataset without images", () => {
    expect(firstPendingItem([{ stem: "a", image: null }])).toBeNull();
    expect(firstPendingItem([])).toBeNull();
  });
});

describe("nextItemAfterReview", () => {
  it("walks to the next image still waiting for review", () => {
    expect(nextItemAfterReview(items, "a")?.stem).toBe("c");
  });

  it("skips the images that already have a decision", () => {
    expect(
      nextItemAfterReview(
        [
          { stem: "a", image: "a.jpg" },
          { stem: "b", image: "b.jpg", review: "approved" as const },
          { stem: "c", image: "c.jpg", review: "rejected" as const },
          { stem: "d", image: "d.jpg" },
        ],
        "a",
      )?.stem,
    ).toBe("d");
  });

  it("falls back to the next openable image once nothing is pending", () => {
    expect(
      nextItemAfterReview(
        [
          { stem: "a", image: "a.jpg" },
          { stem: "b", image: "b.jpg", review: "approved" as const },
        ],
        "a",
      )?.stem,
    ).toBe("b");
  });

  it("never walks into an item without an image, and stops at the end", () => {
    expect(
      nextItemAfterReview(
        [
          { stem: "a", image: "a.jpg" },
          { stem: "half", image: null },
          { stem: "b", image: "b.jpg" },
        ],
        "a",
      )?.stem,
    ).toBe("b");
    expect(nextItemAfterReview(items, "d")).toBeNull();
    expect(nextItemAfterReview(items, "missing")).toBeNull();
  });
});

describe("reviewCounts", () => {
  it("counts every state, counting unreviewed images as pending", () => {
    expect(reviewCounts(items)).toEqual({
      approved: 1,
      pending: 2,
      rejected: 1,
    });
  });
});
