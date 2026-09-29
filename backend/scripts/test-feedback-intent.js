const assert = require("assert/strict");
const { classifyPendingFeedback } = require("../src/feedback-intent");

const now = Date.parse("2026-09-29T12:00:00Z");
const recent = "2026-09-29T11:30:00Z";

function intent(message, requestedAt = recent) {
  return classifyPendingFeedback(message, { requestedAt, now }).intent;
}

assert.equal(intent("I want small chicken tikka pizza, place my order"), "normal");
assert.equal(intent("We did not receive the order"), "complaint");
assert.equal(intent("I didn't get my order"), "complaint");
assert.equal(intent("1/5, the pizza was cold"), "feedback_complaint");
assert.equal(intent("Pizza was amazing!"), "feedback");
assert.equal(intent("⭐⭐⭐⭐⭐"), "feedback");
assert.equal(intent("مجھے آرڈر نہیں ملا"), "complaint");
assert.equal(intent("menu dikhao"), "normal");
assert.equal(intent("5", "2026-09-27T11:30:00Z"), "normal");

console.log("Feedback intent classification keeps orders and complaints out of the feedback-only path: PASS");
